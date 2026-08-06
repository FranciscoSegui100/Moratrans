import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';

export const usuariosRouter = Router();
usuariosRouter.use(requireAuth, requireRol('admin'));

/** GET /api/usuarios — lista de usuarios del panel (solo admin). Nunca expone el hash. */
usuariosRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await query(
    'SELECT id, nombre, email, rol, activo, creado_en FROM usuarios ORDER BY nombre',
  );
  res.json(rows);
});

const nuevoSchema = z.object({
  nombre: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  rol: z.enum(['admin', 'operador', 'finanzas', 'lectura']),
});

/** POST /api/usuarios — crear un usuario del panel (solo admin). */
usuariosRouter.post('/', async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
  const { nombre, email, password, rol } = parsed.data;

  const hash = await bcrypt.hash(password, 10);
  try {
    const [row] = await query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ($1,$2,$3,$4) RETURNING id, nombre, email, rol, activo, creado_en`,
      [nombre, email, hash, rol],
    );
    res.status(201).json(row);
  } catch (e: any) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ese email ya está registrado' });
    console.error('Error al crear usuario:', e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

const patchSchema = z.object({
  nombre: z.string().min(2).optional(),
  rol: z.enum(['admin', 'operador', 'finanzas', 'lectura']).optional(),
  activo: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

/** PATCH /api/usuarios/:id — editar rol/estado/nombre o resetear contraseña (solo admin). */
usuariosRouter.patch('/:id', async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });

  const { password, ...resto } = parsed.data;
  if (req.params.id === req.user!.id && resto.activo === false) {
    return res.status(400).json({ error: 'No podés desactivar tu propia cuenta' });
  }

  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, val] of Object.entries(resto)) {
    params.push(val);
    sets.push(`${k} = $${params.length}`);
  }
  if (password) {
    params.push(await bcrypt.hash(password, 10));
    sets.push(`password_hash = $${params.length}`);
  }
  // Revoca cualquier sesión activa si cambia algo que afecta el acceso: el
  // rol, la desactivación o la contraseña. Los JWT ya emitidos dejan de
  // pasar requireAuth de inmediato (ver middleware/rbac.ts).
  if ('rol' in resto || resto.activo === false || password) {
    sets.push('token_version = token_version + 1');
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
  params.push(req.params.id);

  const [row] = await query(
    `UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, nombre, email, rol, activo, creado_en`,
    params,
  );
  if (!row) return res.status(404).json({ error: 'Usuario inexistente' });
  res.json(row);
});
