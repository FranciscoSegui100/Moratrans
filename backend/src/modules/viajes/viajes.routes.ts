import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendText, motivoErrorWa } from '../whatsapp/graphApi';
import { menuChofer } from '../whatsapp/flows/chofer.flow';
import { notificarEnvioFallido } from '../whatsapp/alertaEnvio';
import { resolverUbicacion } from '../../services/ubicaciones.service';

export const viajesRouter = Router();
viajesRouter.use(requireAuth);

/** GET /api/viajes?fecha=YYYY-MM-DD&estado=programado */
viajesRouter.get('/', async (req: Request, res: Response) => {
  const { fecha, estado } = req.query as Record<string, string>;
  const conds: string[] = [];
  const params: any[] = [];
  if (fecha) { params.push(fecha); conds.push(`v.fecha = $${params.length}`); }
  if (estado) { params.push(estado); conds.push(`v.estado = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await query(
    `SELECT v.id, v.tipo, v.fecha, v.estado, v.zona, v.contenedor_numero, v.destino_direccion,
            v.cliente_telefono, v.notas, c.nombre AS chofer_nombre, v.chofer_id, v.patente, v.grupo_id,
            v.remito, v.importe, v.ubicacion_id, v.ubicacion_direccion,
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
                 WHERE v2.contenedor_numero = v.contenedor_numero AND v2.tipo = 'retiro' AND v2.estado IN ('programado', 'en_curso')
              ) THEN 'para_retirar'
              WHEN ct.estado = 'entregado' AND ct.vence_en IS NOT NULL AND ct.vence_en < now() THEN 'vencido'
              WHEN ct.estado = 'entregado' THEN 'alquilado'
              ELSE ct.estado::text
            END AS contenedor_estado
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
});

/**
 * Le avisa por WhatsApp al chofer que le acaban de programar un viaje desde
 * el panel — aclara si es envío (llevar) o retiro (buscar) del contenedor,
 * y la dirección de destino, si se cargó.
 */
async function avisarChoferViaje(
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

      // A lo sumo una reserva activa por contenedor. Si está disponible, se
      // reserva ya (misma transición que fn_validar_pago, disponible ->
      // reservado). Si está ocupado (con otro cliente), se permite
      // reservarlo igual pero solo para una fecha posterior a su vence_en
      // (fecha de vuelta) — sin tocar su estado actual todavía; el
      // contenedor pasa a "reservado" recién cuando efectivamente vuelve (ver
      // POST /api/contenedores/:numero/confirmar-retiro). Se usa tanto para
      // una entrega suelta como para la pata "entrega" de un recambio.
      async function reservarParaEntrega(numero: string, fecha: string): Promise<void> {
        const { rows: contRows } = await c.query<{ estado: string; vence_en: string | null }>(
          'SELECT estado, vence_en FROM contenedores WHERE numero = $1 FOR UPDATE',
          [numero],
        );
        const cont = contRows[0];
        if (!cont) fail(`El contenedor ${numero} no existe.`);

        const { rows: activos } = await c.query(
          `SELECT id FROM viajes WHERE contenedor_numero = $1 AND tipo = 'entrega' AND estado IN ('programado','en_curso')`,
          [numero],
        );
        if (activos.length > 0) {
          fail(`El contenedor ${numero} ya tiene una entrega reservada (actual o futura); no se puede reservar dos veces.`);
        }

        if (cont!.estado === 'disponible') {
          await c.query(
            `UPDATE contenedores SET estado = 'reservado', actualizado_por = $2
               WHERE numero = $1 AND estado = 'disponible'`,
            [numero, `operador:${req.user!.id}`],
          );
        } else {
          if (!cont!.vence_en) {
            fail(`El contenedor ${numero} está ${cont!.estado} y no tiene fecha de vuelta cargada; no se puede reservar a futuro.`);
          }
          const venceFecha = new Date(cont!.vence_en!).toISOString().slice(0, 10);
          if (fecha < venceFecha) {
            fail(`El contenedor ${numero} vuelve el ${new Date(cont!.vence_en!).toLocaleDateString('es-AR')}; elegí esa fecha o una posterior.`);
          }
          // Sigue "ocupado" hasta que vuelva de verdad — no se toca su estado acá.
        }
      }

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
          await reservarParaEntrega(v.contenedor_numero_entrega, v.fecha);
        }
        const grupoId = randomUUID();
        // `ubicacion` (resuelta arriba como vaciadero, porque tipo !== 'entrega')
        // es el destino del lleno que se retira. El depósito del vacío que se
        // deja se resuelve aparte y sin exigir elección — no hay un segundo
        // selector para esto en el panel, mismo criterio "silencioso" que usa
        // el bot en recambio.flow.ts.
        const deposito = await resolverUbicacion('deposito');
        const { rows: retiroRows } = await c.query(
          `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, remito, importe, grupo_id, ubicacion_id, ubicacion_direccion)
           VALUES ('retiro',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [v.fecha, v.chofer_id ?? null, v.contenedor_numero, v.cliente_telefono ?? null, v.zona ?? null,
           v.destino_direccion ?? null, v.notas ?? null, patente, v.remito ?? null, v.importe ?? null, grupoId,
           ubicacion?.id ?? null, ubicacion?.direccion ?? null],
        );
        const { rows: entregaRows } = await c.query(
          `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, grupo_id, ubicacion_id, ubicacion_direccion)
           VALUES ('entrega',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [v.fecha, v.chofer_id ?? null, v.contenedor_numero_entrega ?? null, v.cliente_telefono ?? null, v.zona ?? null,
           v.destino_direccion ?? null, v.notas ?? null, patente, grupoId, deposito?.id ?? null, deposito?.direccion ?? null],
        );
        return { principal: retiroRows[0], secundario: entregaRows[0] };
      }

      if (v.tipo === 'entrega' && v.contenedor_numero) {
        await reservarParaEntrega(v.contenedor_numero, v.fecha);
      }

      const { rows } = await c.query(
        `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, remito, importe, ubicacion_id, ubicacion_direccion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [v.tipo, v.fecha, v.chofer_id ?? null, v.contenedor_numero ?? null,
         v.cliente_telefono ?? null, v.zona ?? null, v.destino_direccion ?? null, v.notas ?? null, patente,
         v.remito ?? null, v.importe ?? null, ubicacion?.id ?? null, ubicacion?.direccion ?? null],
      );
      return { principal: rows[0], secundario: null as any };
    });

    if (v.chofer_id) {
      avisarChoferViaje(v.chofer_id, resultado.principal.tipo, resultado.principal.contenedor_numero ?? null, v.destino_direccion ?? null).catch((e) => {
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
    const [row] = await query(
      `UPDATE viajes SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'Viaje inexistente' });
    res.json(row);
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
