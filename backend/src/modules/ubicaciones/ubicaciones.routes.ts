import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';

export const ubicacionesRouter = Router();
ubicacionesRouter.use(requireAuth);

/**
 * GET /api/ubicaciones?tipo=deposito|vaciadero — depósitos (origen de una
 * entrega) y vaciaderos (destino de un retiro). Devuelve todas (activas e
 * inactivas) para el panel; los selects de "Programar viaje" filtran las
 * activas del lado del frontend, igual que hace Viajes con choferes.
 */
ubicacionesRouter.get('/', async (req: Request, res: Response) => {
  const tipo = req.query.tipo as string | undefined;
  const rows = tipo
    ? await query('SELECT * FROM ubicaciones WHERE tipo = $1 ORDER BY nombre', [tipo])
    : await query('SELECT * FROM ubicaciones ORDER BY tipo, nombre');
  res.json(rows);
});

const nuevoSchema = z.object({
  tipo: z.enum(['deposito', 'vaciadero']),
  nombre: z.string().min(1).max(150),
  direccion: z.string().min(1).max(300),
});

/** POST /api/ubicaciones — alta de depósito o vaciadero (solo admin). */
ubicacionesRouter.post('/', requireRol('admin'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { tipo, nombre, direccion } = parsed.data;
  const [row] = await query(
    `INSERT INTO ubicaciones (tipo, nombre, direccion) VALUES ($1,$2,$3) RETURNING *`,
    [tipo, nombre.trim(), direccion.trim()],
  );
  res.status(201).json(row);
});

const patchSchema = z.object({
  nombre: z.string().min(1).max(150).optional(),
  direccion: z.string().min(1).max(300).optional(),
  activo: z.boolean().optional(),
});

/** PATCH /api/ubicaciones/:id — editar nombre/dirección o activar/desactivar (solo admin). */
ubicacionesRouter.patch('/:id', requireRol('admin'), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });

  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, val] of Object.entries(parsed.data)) {
    params.push(val);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
  params.push(req.params.id);

  const [row] = await query(
    `UPDATE ubicaciones SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  if (!row) return res.status(404).json({ error: 'Ubicación inexistente' });
  res.json(row);
});

/**
 * DELETE /api/ubicaciones/:id — solo si ya está desactivada (mismo patrón
 * que /api/tarifas): evita borrar por error una ubicación que algún viaje
 * viejo todavía referencia (la FK es ON DELETE SET NULL, pero se pierde el
 * link al historial sin necesidad).
 */
ubicacionesRouter.delete('/:id', requireRol('admin'), async (req: Request, res: Response) => {
  const [ubicacion] = await query<{ activo: boolean }>(
    'SELECT activo FROM ubicaciones WHERE id = $1',
    [req.params.id],
  );
  if (!ubicacion) return res.status(404).json({ error: 'Ubicación inexistente' });
  if (ubicacion.activo) {
    return res.status(409).json({ error: 'Primero desactivá la ubicación para poder borrarla' });
  }
  await query('DELETE FROM ubicaciones WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});
