import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';

export const tarifasRouter = Router();
tarifasRouter.use(requireAuth);

/** GET /api/tarifas — todas las tarifas (activas e inactivas) para el panel. */
tarifasRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await query(
    'SELECT departamento, precio, activo, actualizado_en FROM tarifas_departamento ORDER BY departamento',
  );
  res.json(rows);
});

const nuevoSchema = z.object({
  departamento: z.string().min(2).max(100),
  precio: z.coerce.number().min(0),
});

/** POST /api/tarifas — agregar un nuevo departamento (solo admin). */
tarifasRouter.post('/', requireRol('admin'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { departamento, precio } = parsed.data;
  try {
    const [row] = await query(
      `INSERT INTO tarifas_departamento (departamento, precio) VALUES ($1,$2) RETURNING *`,
      [departamento.trim(), precio],
    );
    res.status(201).json(row);
  } catch (e: any) {
    if (e.code === '23505') return res.status(409).json({ error: 'El departamento ya existe' });
    console.error('Error al insertar tarifa:', e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

const patchSchema = z.object({
  precio: z.coerce.number().min(0).optional(),
  activo: z.boolean().optional(),
});

/** PATCH /api/tarifas/:departamento — modificar precio/activo (solo admin). */
tarifasRouter.patch('/:departamento', requireRol('admin'), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });

  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, val] of Object.entries(parsed.data)) {
    params.push(val);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
  sets.push('actualizado_en = now()');
  params.push(req.params.departamento);

  const [row] = await query(
    `UPDATE tarifas_departamento SET ${sets.join(', ')} WHERE departamento = $${params.length} RETURNING *`,
    params,
  );
  if (!row) return res.status(404).json({ error: 'Departamento inexistente' });
  res.json(row);
});

/**
 * DELETE /api/tarifas/:departamento — borra el departamento (solo admin).
 * Sólo se permite si ya está desactivado, para evitar borrar por error una
 * tarifa que el bot todavía está usando para cotizar.
 */
tarifasRouter.delete('/:departamento', requireRol('admin'), async (req: Request, res: Response) => {
  const [tarifa] = await query<{ activo: boolean }>(
    'SELECT activo FROM tarifas_departamento WHERE departamento = $1',
    [req.params.departamento],
  );
  if (!tarifa) return res.status(404).json({ error: 'Departamento inexistente' });
  if (tarifa.activo) {
    return res.status(409).json({ error: 'Primero desactivá el departamento para poder borrarlo' });
  }
  await query('DELETE FROM tarifas_departamento WHERE departamento = $1', [req.params.departamento]);
  res.json({ success: true });
});
