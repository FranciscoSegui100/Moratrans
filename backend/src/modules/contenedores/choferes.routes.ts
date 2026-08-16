import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol, puedeVerDni, Rol } from '../../middleware/rbac';
import { encrypt, decrypt, blindIndex } from '../../services/crypto.service';
import { normalizarTelefonoAR } from '../../services/telefono.service';

export const choferesRouter = Router();
choferesRouter.use(requireAuth);

// Presenta un chofer: descifra el DNI solo si el rol tiene permiso; si no, lo enmascara.
// dni_enc puede ser NULL: se anonimiza a los 365 días de inactivo (sección 9, ver limpieza.cron.ts).
function presentar(row: any, rol: Rol) {
  return {
    id: row.id,
    nombre: row.nombre,
    telefono: row.telefono,
    patente: row.patente,
    activo: row.activo,
    dni: row.dni_enc ? (puedeVerDni(rol) ? decrypt(row.dni_enc) : '••••••') : null,
  };
}

/** GET /api/choferes — DNI descifrado solo para admin/operador. */
choferesRouter.get('/', async (req: Request, res: Response) => {
  const rows = await query('SELECT id, nombre, dni_enc, telefono, patente, activo FROM choferes ORDER BY nombre');
  res.json(rows.map((r) => presentar(r, req.user!.rol)));
});

const nuevoSchema = z.object({
  nombre: z.string().min(2),
  dni: z.string().min(4),
  telefono: z.string().min(6),
  patente: z.string().min(1).optional(),
});

/** POST /api/choferes — alta con DNI cifrado (solo admin/operador). */
choferesRouter.post('/', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { nombre, dni, telefono, patente } = parsed.data;
  try {
    const [row] = await query(
      `INSERT INTO choferes (nombre, dni_enc, dni_hash, telefono, patente)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, nombre, dni_enc, telefono, patente, activo`,
      [nombre, encrypt(dni), blindIndex(dni), normalizarTelefonoAR(telefono), patente?.toUpperCase() ?? null],
    );
    res.status(201).json(presentar(row, req.user!.rol));
  } catch (e: any) {
    res.status(409).json({ error: 'DNI o teléfono ya registrado' });
  }
});

const patchSchema = z.object({
  nombre: z.string().min(2).optional(),
  telefono: z.string().min(6).optional(),
  dni: z.string().min(4).optional(),
  patente: z.string().min(1).nullable().optional(),
  activo: z.boolean().optional(),
});

/** PATCH /api/choferes/:id — modificar un chofer, incluido el DNI (solo admin/operador). */
choferesRouter.patch('/:id', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });

  const { dni, ...resto } = parsed.data;
  const sets: string[] = [];
  const params: any[] = [];

  for (const [k, val] of Object.entries(resto)) {
    params.push(k === 'telefono' ? normalizarTelefonoAR(val as string) : val);
    sets.push(`${k} = $${params.length}`);
  }
  // Retención de DNI (sección 9): desactivado_en marca desde cuándo cuenta
  // el plazo de anonimización (limpieza.cron.ts); se limpia si se reactiva.
  if (resto.activo === false) {
    sets.push('desactivado_en = now()');
  } else if (resto.activo === true) {
    sets.push('desactivado_en = NULL');
  }
  // El DNI no es una columna directa: se guarda cifrado + su blind index de búsqueda.
  if (dni) {
    params.push(encrypt(dni));
    sets.push(`dni_enc = $${params.length}`);
    params.push(blindIndex(dni));
    sets.push(`dni_hash = $${params.length}`);
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
    res.status(409).json({ error: 'DNI o teléfono ya registrado' });
  }
});

/**
 * POST /api/choferes/:id/desvincular — libera el número de WhatsApp del
 * chofer (solo admin/operador). Paso explícito requerido antes de poder
 * vincular ese número a otro chofer: sin esto, la única forma de "liberarlo"
 * era pisar el campo `telefono` a mano con cualquier otro valor desde el
 * PATCH genérico (sección 23 del documento maestro).
 */
choferesRouter.post('/:id/desvincular', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const [row] = await query(
    `UPDATE choferes SET telefono = NULL WHERE id = $1 RETURNING id, nombre, dni_enc, telefono, activo`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: 'Chofer inexistente' });
  res.json(presentar(row, req.user!.rol));
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
