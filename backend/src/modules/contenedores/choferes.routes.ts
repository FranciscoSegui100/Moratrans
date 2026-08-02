import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol, puedeVerDni, Rol } from '../../middleware/rbac';
import { encrypt, decrypt, blindIndex } from '../../services/crypto.service';

export const choferesRouter = Router();
choferesRouter.use(requireAuth);

// Presenta un chofer: descifra el DNI solo si el rol tiene permiso; si no, lo enmascara.
function presentar(row: any, rol: Rol) {
  return {
    id: row.id,
    nombre: row.nombre,
    telefono: row.telefono,
    activo: row.activo,
    dni: puedeVerDni(rol) ? decrypt(row.dni_enc) : '••••••',
  };
}

/** GET /api/choferes — DNI descifrado solo para admin/operador. */
choferesRouter.get('/', async (req: Request, res: Response) => {
  const rows = await query('SELECT id, nombre, dni_enc, telefono, activo FROM choferes ORDER BY nombre');
  res.json(rows.map((r) => presentar(r, req.user!.rol)));
});

const nuevoSchema = z.object({
  nombre: z.string().min(2),
  dni: z.string().min(4),
  telefono: z.string().min(6),
});

/** POST /api/choferes — alta con DNI cifrado (solo admin/operador). */
choferesRouter.post('/', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { nombre, dni, telefono } = parsed.data;
  try {
    const [row] = await query(
      `INSERT INTO choferes (nombre, dni_enc, dni_hash, telefono)
       VALUES ($1,$2,$3,$4) RETURNING id, nombre, dni_enc, telefono, activo`,
      [nombre, encrypt(dni), blindIndex(dni), telefono],
    );
    res.status(201).json(presentar(row, req.user!.rol));
  } catch (e: any) {
    res.status(409).json({ error: 'DNI o teléfono ya registrado' });
  }
});

const patchSchema = z.object({
  nombre: z.string().min(2).optional(),
  telefono: z.string().min(6).optional(),
  activo: z.boolean().optional(),
});

/** PATCH /api/choferes/:id — modificar un chofer (solo admin/operador). Note: DNI no se puede modificar fácilmente. */
choferesRouter.patch('/:id', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
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
  
  try {
    const [row] = await query(
      `UPDATE choferes SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, nombre, dni_enc, telefono, activo`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'Chofer inexistente' });
    res.json(presentar(row, req.user!.rol));
  } catch (e: any) {
    res.status(409).json({ error: 'Teléfono ya registrado' });
  }
});

/** DELETE /api/choferes/:id — borrar un chofer (solo admin/operador). */
choferesRouter.delete('/:id', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  try {
    const [row] = await query('DELETE FROM choferes WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Chofer inexistente' });
    res.json({ success: true });
  } catch (e: any) {
    if (e.code === '23503') { // Foreign key violation
      res.status(400).json({ error: 'No se puede eliminar el chofer porque tiene viajes o historiales asociados.' });
    } else {
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
});
