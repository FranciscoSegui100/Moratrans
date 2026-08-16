import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendText, motivoErrorWa } from '../whatsapp/graphApi';
import { menuChofer } from '../whatsapp/flows/chofer.flow';
import { notificarEnvioFallido } from '../whatsapp/alertaEnvio';

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
            v.remito, v.importe,
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
  tipo: z.enum(['entrega', 'retiro']),
  fecha: z.string(), // YYYY-MM-DD
  chofer_id: z.string().uuid().optional(),
  contenedor_numero: z.string().optional(),
  cliente_telefono: z.string().optional(),
  zona: z.string().optional(),
  destino_direccion: z.string().optional(),
  notas: z.string().optional(),
  remito: z.string().optional(),
  importe: z.coerce.number().nonnegative().optional(),
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

/** POST /api/viajes — programar un viaje (admin/operador). */
viajesRouter.post('/', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const v = parsed.data;
  try {
    const row = await withTx(async (c) => {
      // Entrega: a lo sumo una reserva activa por contenedor. Si está
      // disponible, se reserva ya (misma transición que fn_validar_pago,
      // disponible -> reservado). Si está ocupado (con otro cliente), se
      // permite reservarlo igual pero solo para una fecha posterior a su
      // vence_en (fecha de vuelta) — sin tocar su estado actual todavía; el
      // contenedor pasa a "reservado" recién cuando efectivamente vuelve (ver
      // POST /api/contenedores/:numero/confirmar-retiro).
      if (v.tipo === 'entrega' && v.contenedor_numero) {
        const { rows: contRows } = await c.query<{ estado: string; vence_en: string | null }>(
          'SELECT estado, vence_en FROM contenedores WHERE numero = $1 FOR UPDATE',
          [v.contenedor_numero],
        );
        const cont = contRows[0];
        const fail = (msg: string): never => {
          const err: any = new Error(msg);
          err.status = 409;
          throw err;
        };
        if (!cont) fail(`El contenedor ${v.contenedor_numero} no existe.`);

        const { rows: activos } = await c.query(
          `SELECT id FROM viajes WHERE contenedor_numero = $1 AND tipo = 'entrega' AND estado IN ('programado','en_curso')`,
          [v.contenedor_numero],
        );
        if (activos.length > 0) {
          fail(`El contenedor ${v.contenedor_numero} ya tiene una entrega reservada (actual o futura); no se puede reservar dos veces.`);
        }

        if (cont!.estado === 'disponible') {
          await c.query(
            `UPDATE contenedores SET estado = 'reservado', actualizado_por = $2
               WHERE numero = $1 AND estado = 'disponible'`,
            [v.contenedor_numero, `operador:${req.user!.id}`],
          );
        } else {
          if (!cont!.vence_en) {
            fail(`El contenedor ${v.contenedor_numero} está ${cont!.estado} y no tiene fecha de vuelta cargada; no se puede reservar a futuro.`);
          }
          const venceFecha = new Date(cont!.vence_en!).toISOString().slice(0, 10);
          if (v.fecha < venceFecha) {
            fail(`El contenedor ${v.contenedor_numero} vuelve el ${new Date(cont!.vence_en!).toLocaleDateString('es-AR')}; elegí esa fecha o una posterior.`);
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

      const { rows } = await c.query(
        `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, remito, importe)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [v.tipo, v.fecha, v.chofer_id ?? null, v.contenedor_numero ?? null,
         v.cliente_telefono ?? null, v.zona ?? null, v.destino_direccion ?? null, v.notas ?? null, patente,
         v.remito ?? null, v.importe ?? null],
      );
      return rows[0];
    });

    if (v.chofer_id) {
      avisarChoferViaje(v.chofer_id, v.tipo, v.contenedor_numero ?? null, v.destino_direccion ?? null).catch((e) => {
        const motivo = motivoErrorWa(e);
        console.error('Error avisando al chofer el viaje programado:', motivo);
        notificarEnvioFallido(row.id, `chofer del viaje ${row.id}`, 'aviso de viaje programado', motivo).catch(
          (e2) => console.error('Error registrando alerta de envío fallido:', e2),
        );
      });
    }

    res.status(201).json(row);
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
