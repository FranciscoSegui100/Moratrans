import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendText, motivoErrorWa } from '../whatsapp/graphApi';
import { menuChofer } from '../whatsapp/flows/chofer.flow';
import { notificarEnvioFallido } from '../whatsapp/alertaEnvio';
import { resolverUbicacion } from '../../services/ubicaciones.service';
import { reservarParaEntrega } from '../../services/contenedorReserva.service';
import { emitRecursoActualizado } from '../../config/socket';

export const viajesRouter = Router();
viajesRouter.use(requireAuth);

/**
 * GET /api/viajes?fecha=YYYY-MM-DD&estado=programado&chofer_id=&ruta_id=
 * `ruta_id=null` (el literal, no el valor JS) filtra los viajes SIN rutear
 * todavía — es la cola de la pestaña Ruta (ver rutas.routes.ts). No filtra
 * por fecha a propósito en ese caso: un pedido de hoy tiene que poder verse
 * al armar la ruta de pasado mañana.
 */
viajesRouter.get('/', async (req: Request, res: Response) => {
  const { fecha, estado, chofer_id: choferId, ruta_id: rutaId } = req.query as Record<string, string>;
  const conds: string[] = [];
  const params: any[] = [];
  if (fecha) { params.push(fecha); conds.push(`v.fecha = $${params.length}`); }
  if (estado) { params.push(estado); conds.push(`v.estado = $${params.length}`); }
  if (choferId) { params.push(choferId); conds.push(`v.chofer_id = $${params.length}`); }
  if (rutaId === 'null') conds.push(`v.ruta_id IS NULL`);
  else if (rutaId) { params.push(rutaId); conds.push(`v.ruta_id = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await query(
    `SELECT v.id, v.tipo, v.fecha, v.estado, v.zona, v.contenedor_numero, v.destino_direccion,
            v.destino_lat, v.destino_lng, v.horario_preferido, v.hora_estimada,
            v.cliente_telefono, v.notas, c.nombre AS chofer_nombre, v.chofer_id, v.patente, v.grupo_id,
            v.remito, v.importe, v.ubicacion_id, v.ubicacion_direccion, v.ruta_id, v.orden,
            v.es_cuenta_corriente, v.pago_id,
            -- Origen/destino final del viaje: la entrega sale del depósito
            -- (ubicacion_direccion) y llega a lo del cliente (destino_direccion);
            -- el retiro sale de lo del cliente y llega al vaciadero. No se
            -- guarda como columna aparte para no duplicar datos.
            CASE WHEN v.tipo = 'entrega' THEN v.ubicacion_direccion ELSE v.destino_direccion END AS origen_direccion,
            CASE WHEN v.tipo = 'entrega' THEN v.destino_direccion ELSE v.ubicacion_direccion END AS destino_final_direccion,
            -- Misma vista "por contrato" que GET /api/contenedores (columna
            -- estado_contrato) — expresión duplicada a propósito, mantener en sync.
            CASE
              WHEN EXISTS (
                SELECT 1 FROM viajes v2
                 WHERE v2.contenedor_numero = v.contenedor_numero AND v2.tipo = 'retiro' AND v2.estado = 'en_curso'
              ) THEN 'yendo_a_vaciar'
              WHEN EXISTS (
                SELECT 1 FROM viajes v2
                 WHERE v2.contenedor_numero = v.contenedor_numero AND v2.tipo = 'retiro' AND v2.estado = 'programado'
              ) THEN 'para_retirar'
              WHEN ct.estado = 'entregado' AND ct.vence_en IS NOT NULL AND ct.vence_en < now() THEN 'vencido'
              WHEN ct.estado = 'entregado' THEN 'alquilado'
              ELSE ct.estado::text
            END AS contenedor_estado,
            -- Comprobantes asociados (inicial de flete + extensiones de alargue_retiro)
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', p.id,
                'tipo', p.tipo,
                'monto', p.monto,
                'estado', p.estado,
                'es_cuenta_corriente', p.es_cuenta_corriente,
                'tiene_comprobante', (p.url_comprobante IS NOT NULL),
                'titular', p.titular_transferencia,
                'creado_en', p.creado_en
              ) ORDER BY p.creado_en ASC)
              FROM pagos p
              WHERE (p.id = v.pago_id)
                 OR (p.tipo = 'alargue_retiro'
                     AND p.contenedor_numero = v.contenedor_numero
                     AND (p.cliente_telefono = v.cliente_telefono OR v.cliente_telefono IS NULL))
                 OR (v.pago_id IS NULL
                     AND p.tipo = 'flete'
                     AND p.cliente_telefono = v.cliente_telefono
                     AND p.creado_en::date <= v.fecha
                     AND p.creado_en >= v.creado_en - interval '3 days')
            ), '[]'::json) AS comprobantes
       FROM viajes v
       LEFT JOIN choferes c ON c.id = v.chofer_id
       LEFT JOIN contenedores ct ON ct.numero = v.contenedor_numero
       ${where}
       ORDER BY v.fecha, v.creado_en`,
    params,
  );
  res.json(rows);
});

const nuevoSchema = z.object({
  // 'recambio' no es un tipo_viaje real en la DB: crea un par 'retiro'+'entrega'
  // unido por grupo_id (ver comentario de viajes.grupo_id en schema.sql).
  tipo: z.enum(['entrega', 'retiro', 'recambio']),
  fecha: z.string(), // YYYY-MM-DD
  chofer_id: z.string().uuid().optional(),
  // retiro: el contenedor que se retira. entrega: el que se entrega.
  // recambio: el lleno que se retira (obligatorio).
  contenedor_numero: z.string().optional(),
  // Solo recambio: el vacío que se deja. Si no se manda, la pata 'entrega'
  // queda sin contenedor para que el operador lo asigne después (misma UI
  // "Asignar" que ya existe en la tabla de Viajes).
  contenedor_numero_entrega: z.string().optional(),
  cliente_telefono: z.string().optional(),
  zona: z.string().optional(),
  destino_direccion: z.string().optional(),
  notas: z.string().optional(),
  remito: z.string().optional(),
  importe: z.coerce.number().nonnegative().optional(),
  // Depósito (si tipo='entrega') o vaciadero (si tipo='retiro') de donde
  // sale/adonde llega el contenedor del lado de la empresa (ver GET /,
  // columna origen_direccion). Opcional si sólo hay una ubicación activa de
  // ese tipo: se autoselecciona más abajo.
  ubicacion_id: z.string().uuid().optional(),
  // Hora estimada que carga el operador (llegada si es entrega, retiro si es
  // retiro) — "HH:MM", independiente de horario_preferido (lo pidió el
  // cliente por WhatsApp, ver horarioPreferido.flow.ts).
  hora_estimada: z.string().optional(),
});

/**
 * Le avisa por WhatsApp al chofer que le acaban de programar un viaje desde
 * el panel — aclara si es envío (llevar) o retiro (buscar) del contenedor,
 * y la dirección de destino, si se cargó.
 */
export async function avisarChoferViaje(
  choferId: string,
  tipo: 'entrega' | 'retiro',
  contenedorNumero: string | null,
  destinoDireccion: string | null,
): Promise<void> {
  const [chofer] = await query<{ telefono: string | null; nombre: string }>(
    'SELECT telefono, nombre FROM choferes WHERE id = $1',
    [choferId],
  );
  if (!chofer?.telefono) return; // chofer sin número vinculado todavía: nada que mandar

  const titulo = tipo === 'entrega' ? '📦 Envío de contenedor' : '📥 Retiro de contenedor';
  const destino = destinoDireccion
    ? `${destinoDireccion}\nhttps://www.google.com/maps?q=${encodeURIComponent(destinoDireccion)}`
    : 'Sin ubicación registrada, coordiná con el cliente.';

  await sendText(
    chofer.telefono,
    `🚚 *${titulo}*\n\n` +
      (contenedorNumero ? `Contenedor: *${contenedorNumero}*\n` : '') +
      `📍 Ubicación:\n${destino}`,
  );
  await menuChofer(chofer.telefono, chofer.nombre);
}

/**
 * Aviso específico para un recambio: a diferencia de avisarChoferViaje (que
 * solo hablaría del "retiro" del lleno), acá se le aclara al chofer que es
 * un recambio y qué contenedor vacío le corresponde dejar — y de qué
 * ubicación sale ese vacío, si ya se sabe.
 */
export async function avisarChoferRecambio(
  choferId: string,
  llenoNumero: string,
  vacioNumero: string | null,
  vacioUbicacionId: string | null,
  destinoDireccion: string | null,
): Promise<void> {
  const [chofer] = await query<{ telefono: string | null; nombre: string }>(
    'SELECT telefono, nombre FROM choferes WHERE id = $1',
    [choferId],
  );
  if (!chofer?.telefono) return;

  let ubicacionNombre: string | null = null;
  if (vacioUbicacionId) {
    const [u] = await query<{ nombre: string }>('SELECT nombre FROM ubicaciones WHERE id = $1', [vacioUbicacionId]);
    ubicacionNombre = u?.nombre ?? null;
  }

  const destino = destinoDireccion
    ? `${destinoDireccion}\nhttps://www.google.com/maps?q=${encodeURIComponent(destinoDireccion)}`
    : 'Sin ubicación registrada, coordiná con el cliente.';

  const lineaVacio = vacioNumero
    ? `Se asignó el contenedor *${vacioNumero}* para el recambio del contenedor *${llenoNumero}*` +
      (ubicacionNombre ? `, de la ubicación: *${ubicacionNombre}*` : '') + '.\n'
    : `Retirás el contenedor *${llenoNumero}* — el vacío que dejás todavía no está asignado.\n`;

  await sendText(
    chofer.telefono,
    `🔄 *Recambio*\n\n${lineaVacio}📍 Ubicación:\n${destino}`,
  );
  await menuChofer(chofer.telefono, chofer.nombre);
}

/** POST /api/viajes — programar un viaje, o un recambio (par retiro+entrega) (admin/operador). */
viajesRouter.post('/', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const v = parsed.data;

  // Depósito para una entrega, vaciadero para un retiro. Si no se especificó
  // uno y hay más de una ubicación activa de ese tipo, hace falta que el
  // operador elija — a diferencia de los flujos del bot, acá sí se puede
  // pedir explícitamente (ver ubicaciones.service.ts).
  const tipoUbicacion = v.tipo === 'entrega' ? 'deposito' : 'vaciadero';
  let ubicacion: { id: string; direccion: string } | null = null;
  if (v.ubicacion_id) {
    ubicacion = await resolverUbicacion(tipoUbicacion, v.ubicacion_id);
    if (!ubicacion) return res.status(400).json({ error: 'Ubicación inválida para este tipo de viaje.' });
  } else {
    const activas = await query<{ id: string; direccion: string }>(
      'SELECT id, direccion FROM ubicaciones WHERE tipo = $1 AND activo = TRUE ORDER BY creado_en',
      [tipoUbicacion],
    );
    if (activas.length === 1) ubicacion = activas[0];
    else if (activas.length > 1) {
      return res.status(400).json({
        error: `Elegí ${tipoUbicacion === 'deposito' ? 'un depósito' : 'un vaciadero'}: hay más de uno cargado.`,
      });
    }
    // 0 activas: se deja sin ubicación (todavía no se cargó ninguna en /ubicaciones).
  }

  try {
    const resultado = await withTx(async (c) => {
      const fail = (msg: string): never => {
        const err: any = new Error(msg);
        err.status = 409;
        throw err;
      };

      // reservarParaEntrega (backend/src/services/contenedorReserva.service.ts):
      // a lo sumo una reserva activa por contenedor, se usa tanto para una
      // entrega suelta como para la pata "entrega" de un recambio.
      const actualizadoPor = `operador:${req.user!.id}`;

      // Foto de la patente del chofer al momento de crear el viaje (ver
      // comentario de viajes.patente en schema.sql).
      let patente: string | null = null;
      if (v.chofer_id) {
        const { rows: choferRows } = await c.query<{ patente: string | null }>(
          'SELECT patente FROM choferes WHERE id = $1',
          [v.chofer_id],
        );
        patente = choferRows[0]?.patente ?? null;
      }

      if (v.tipo === 'recambio') {
        if (!v.contenedor_numero) fail('Un recambio necesita el contenedor lleno que se va a retirar.');
        if (v.contenedor_numero_entrega) {
          await reservarParaEntrega(c, v.contenedor_numero_entrega, v.fecha, actualizadoPor);
        }
        const grupoId = randomUUID();
        // `ubicacion` (resuelta arriba como vaciadero, porque tipo !== 'entrega')
        // es el destino del lleno que se retira. El depósito del vacío que se
        // deja se resuelve aparte y sin exigir elección — no hay un segundo
        // selector para esto en el panel, mismo criterio "silencioso" que usa
        // el bot en recambio.flow.ts.
        const deposito = await resolverUbicacion('deposito');
        const { rows: retiroRows } = await c.query(
          `INSERT INTO viajes (tipo, fecha, hora_estimada, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, remito, importe, grupo_id, ubicacion_id, ubicacion_direccion)
           VALUES ('retiro',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [v.fecha, v.hora_estimada || null, v.chofer_id ?? null, v.contenedor_numero, v.cliente_telefono ?? null, v.zona ?? null,
           v.destino_direccion ?? null, v.notas ?? null, patente, v.remito ?? null, v.importe ?? null, grupoId,
           ubicacion?.id ?? null, ubicacion?.direccion ?? null],
        );
        const { rows: entregaRows } = await c.query(
          `INSERT INTO viajes (tipo, fecha, hora_estimada, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, grupo_id, ubicacion_id, ubicacion_direccion)
           VALUES ('entrega',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [v.fecha, v.hora_estimada || null, v.chofer_id ?? null, v.contenedor_numero_entrega ?? null, v.cliente_telefono ?? null, v.zona ?? null,
           v.destino_direccion ?? null, v.notas ?? null, patente, grupoId, deposito?.id ?? null, deposito?.direccion ?? null],
        );
        return { principal: retiroRows[0], secundario: entregaRows[0] };
      }

      if (v.tipo === 'entrega' && v.contenedor_numero) {
        await reservarParaEntrega(c, v.contenedor_numero, v.fecha, actualizadoPor);
      }

      const { rows } = await c.query(
        `INSERT INTO viajes (tipo, fecha, hora_estimada, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, remito, importe, ubicacion_id, ubicacion_direccion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [v.tipo, v.fecha, v.hora_estimada || null, v.chofer_id ?? null, v.contenedor_numero ?? null,
         v.cliente_telefono ?? null, v.zona ?? null, v.destino_direccion ?? null, v.notas ?? null, patente,
         v.remito ?? null, v.importe ?? null, ubicacion?.id ?? null, ubicacion?.direccion ?? null],
      );
      return { principal: rows[0], secundario: null as any };
    });

    if (v.chofer_id) {
      const avisoRecambioOChofer = v.tipo === 'recambio'
        ? avisarChoferRecambio(
            v.chofer_id,
            resultado.principal.contenedor_numero!,
            resultado.secundario?.contenedor_numero ?? null,
            resultado.secundario?.ubicacion_id ?? null,
            v.destino_direccion ?? null,
          )
        : avisarChoferViaje(v.chofer_id, resultado.principal.tipo, resultado.principal.contenedor_numero ?? null, v.destino_direccion ?? null);
      avisoRecambioOChofer.catch((e) => {
        const motivo = motivoErrorWa(e);
        console.error('Error avisando al chofer el viaje programado:', motivo);
        notificarEnvioFallido(resultado.principal.id, `chofer del viaje ${resultado.principal.id}`, 'aviso de viaje programado', motivo).catch(
          (e2) => console.error('Error registrando alerta de envío fallido:', e2),
        );
      });
    }

    res.status(201).json(resultado.principal);
  } catch (error: any) {
    if (error.status === 409) {
      res.status(409).json({ error: error.message });
    } else if (error.code === '23503') { // Foreign key violation
      res.status(400).json({ error: 'El contenedor o chofer especificado no existe.' });
    } else {
      console.error('Error al insertar viaje:', error);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
});

const patchSchema = z.object({
  estado: z.enum(['programado', 'en_curso', 'completado', 'cancelado']).optional(),
  fecha: z.string().optional(),
  // Hora estimada de llegada (entrega) o de retiro (retiro) que carga el
  // operador — "HH:MM" o null para borrarla.
  hora_estimada: z.string().nullable().optional(),
  chofer_id: z.string().uuid().nullable().optional(),
  // Sobre todo para completar la fila 'entrega' de un recambio (ver
  // recambio.flow.ts): se crea sin contenedor porque el bot no elige cuál
  // vacío sale — el operador lo asigna acá, como cualquier entrega nueva.
  contenedor_numero: z.string().min(1).nullable().optional(),
  remito: z.string().nullable().optional(),
  importe: z.coerce.number().nonnegative().nullable().optional(),
  ubicacion_id: z.string().uuid().nullable().optional(),
});

/** PATCH /api/viajes/:id — cambiar estado, reasignar chofer o contenedor (admin/operador). */
viajesRouter.patch('/:id', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  // '' (input de hora vaciado) no es un TIME válido para Postgres — se
  // interpreta como "borrar la hora estimada".
  if (parsed.data.hora_estimada === '') parsed.data.hora_estimada = null;
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, val] of Object.entries(parsed.data)) {
    params.push(val); sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
  // Reasignar chofer también actualiza la foto de patente del viaje (ver
  // comentario de viajes.patente en schema.sql).
  if ('chofer_id' in parsed.data) {
    const nuevoChoferId = parsed.data.chofer_id;
    const patente = nuevoChoferId
      ? (await query<{ patente: string | null }>('SELECT patente FROM choferes WHERE id = $1', [nuevoChoferId]))[0]?.patente ?? null
      : null;
    params.push(patente); sets.push(`patente = $${params.length}`);
  }
  // Reasignar la ubicación (depósito/vaciadero) también recalcula la foto de
  // su dirección — mismo patrón que chofer_id/patente arriba.
  if ('ubicacion_id' in parsed.data) {
    const nuevoUbicacionId = parsed.data.ubicacion_id;
    let direccion: string | null = null;
    if (nuevoUbicacionId) {
      const [viajeActual] = await query<{ tipo: 'entrega' | 'retiro' }>(
        'SELECT tipo FROM viajes WHERE id = $1',
        [req.params.id],
      );
      if (!viajeActual) return res.status(404).json({ error: 'Viaje inexistente' });
      const tipoUbicacion = viajeActual.tipo === 'entrega' ? 'deposito' : 'vaciadero';
      const ubicacion = await resolverUbicacion(tipoUbicacion, nuevoUbicacionId);
      if (!ubicacion) return res.status(400).json({ error: 'Ubicación inválida para este tipo de viaje.' });
      direccion = ubicacion.direccion;
    }
    params.push(direccion); sets.push(`ubicacion_direccion = $${params.length}`);
  }
  params.push(req.params.id);
  try {
    // Asignar contenedor a una entrega (sobre todo el vacío de un recambio,
    // ver comentario de contenedor_numero en patchSchema) tiene que reservarlo
    // de verdad — misma validación atómica que un viaje nuevo (POST /) o que
    // confirmar una ruta: si no, el contenedor sigue figurando 'disponible' y
    // el bot puede volver a ofrecérselo a otro cliente (o el pago validarlo
    // solo) mientras "ya estaba asignado" en el panel.
    const row = await withTx(async (c) => {
      if ('contenedor_numero' in parsed.data && parsed.data.contenedor_numero) {
        const { rows: viajeRows } = await c.query<{ tipo: string; fecha: string }>(
          'SELECT tipo, fecha FROM viajes WHERE id = $1 FOR UPDATE',
          [req.params.id],
        );
        if (!viajeRows[0]) return null;
        if (viajeRows[0].tipo === 'entrega') {
          await reservarParaEntrega(c, parsed.data.contenedor_numero, viajeRows[0].fecha, `operador:${req.user!.id}`, {
            excluirViajeId: req.params.id,
          });
        }
      }
      const { rows } = await c.query(
        `UPDATE viajes SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      return rows[0] ?? null;
    });
    if (!row) return res.status(404).json({ error: 'Viaje inexistente' });

    res.json(row);

    // Reasignar chofer no pasa por broadcastCambios de la pestaña
    // Contenedores (esa ruta es '/viajes/...', solo avisa 'viajes') — sin
    // esto, la columna "Chofer asignado" de Contenedores quedaba
    // desactualizada hasta hacer F5.
    const cambioChofer = 'chofer_id' in parsed.data;
    const cambioContenedorEntrega = 'contenedor_numero' in parsed.data && !!row.contenedor_numero && row.tipo === 'entrega';
    if (cambioChofer || cambioContenedorEntrega) emitRecursoActualizado('contenedores');

    // Si se tocó el chofer (asignación nueva o reasignación) o se acaba de
    // completar el contenedor de una entrega (típicamente el vacío de un
    // recambio, ver comentario de contenedor_numero en patchSchema), y ya
    // hay alguien asignado, le mandamos el mismo aviso que recibiría si el
    // viaje se hubiera creado así desde el principio — antes esto solo
    // pasaba en POST /api/viajes, así que reasignar desde la tabla de Viajes
    // no le avisaba nada al chofer nuevo.
    if (row.chofer_id && (cambioChofer || cambioContenedorEntrega)) {
      (async () => {
        if (row.grupo_id) {
          const [retiro] = await query<{ contenedor_numero: string | null }>(
            `SELECT contenedor_numero FROM viajes WHERE grupo_id = $1 AND tipo = 'retiro' LIMIT 1`,
            [row.grupo_id],
          );
          const [entrega] = await query<{ contenedor_numero: string | null; ubicacion_id: string | null }>(
            `SELECT contenedor_numero, ubicacion_id FROM viajes WHERE grupo_id = $1 AND tipo = 'entrega' LIMIT 1`,
            [row.grupo_id],
          );
          if (retiro?.contenedor_numero) {
            await avisarChoferRecambio(row.chofer_id, retiro.contenedor_numero, entrega?.contenedor_numero ?? null, entrega?.ubicacion_id ?? null, row.destino_direccion);
          }
        } else {
          await avisarChoferViaje(row.chofer_id, row.tipo, row.contenedor_numero, row.destino_direccion);
        }
      })().catch((e) => {
        const motivo = motivoErrorWa(e);
        console.error('Error avisando al chofer la asignación:', motivo);
        notificarEnvioFallido(row.id, `chofer del viaje ${row.id}`, 'aviso de asignación', motivo).catch(
          (e2) => console.error('Error registrando alerta de envío fallido:', e2),
        );
      });
    }
  } catch (error: any) {
    if (error.code === '23503') { // Foreign key violation
      res.status(400).json({ error: 'El chofer especificado no existe.' });
    } else {
      console.error('Error al actualizar viaje:', error);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
});

/** DELETE /api/viajes/:id — eliminar un viaje (solo admin, idealmente cuando está completado o cancelado). */
viajesRouter.delete('/:id', requireRol('admin'), async (req: Request, res: Response) => {
  try {
    const [row] = await query('DELETE FROM viajes WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Viaje inexistente' });
    res.json({ success: true });
  } catch (e: any) {
    console.error('Error al eliminar viaje:', e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});
