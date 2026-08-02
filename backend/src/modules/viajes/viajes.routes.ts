import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';

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
    `SELECT v.id, v.tipo, v.fecha, v.estado, v.zona, v.contenedor_numero,
            v.cliente_telefono, v.notas, c.nombre AS chofer_nombre, v.chofer_id
       FROM viajes v LEFT JOIN choferes c ON c.id = v.chofer_id
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
  notas: z.string().optional(),
});

/** POST /api/viajes — programar un viaje (admin/operador). */
viajesRouter.post('/', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const v = parsed.data;
  try {
    const [row] = await query(
      `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, cliente_telefono, zona, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [v.tipo, v.fecha, v.chofer_id ?? null, v.contenedor_numero ?? null,
       v.cliente_telefono ?? null, v.zona ?? null, v.notas ?? null],
    );
    res.status(201).json(row);
  } catch (error: any) {
    if (error.code === '23503') { // Foreign key violation
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
});

/** PATCH /api/viajes/:id — cambiar estado o reasignar chofer (admin/operador). */
viajesRouter.patch('/:id', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, val] of Object.entries(parsed.data)) {
    params.push(val); sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
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
