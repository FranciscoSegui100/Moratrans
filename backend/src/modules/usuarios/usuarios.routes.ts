import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { revocarTodasLasSesiones } from '../../services/session.service';
import { crearTokenAccion } from '../../services/token-accion.service';
import { enviarInvitacion, linkInvitacion } from '../../services/email.service';
import { validarPassword } from '../../services/password-policy.service';

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
  rol: z.enum(['admin', 'operador', 'finanzas', 'lectura']),
});

/**
 * POST /api/usuarios — crear un usuario del panel (solo admin).
 * Ya no recibe una contraseña puesta a mano por el admin (evita compartirla
 * por WhatsApp/Slack/etc.): se crea con un hash aleatorio inutilizable y se
 * manda una invitación por email para que el usuario elija su propia
 * contraseña con un link de un solo uso (ver /api/auth/set-password).
 */
usuariosRouter.post('/', async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
  const { nombre, email, rol } = parsed.data;

  const hashInutilizable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  try {
    const [row] = await query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ($1,$2,$3,$4) RETURNING id, nombre, email, rol, activo, creado_en`,
      [nombre, email, hashInutilizable, rol],
    );
    const token = await crearTokenAccion(row.id, 'invitacion');
    const emailEnviado = await enviarInvitacion(email, nombre, token);
    res.status(201).json({
      ...row,
      emailEnviado,
      // Solo se manda al frontend si el email falló: es la única forma de que
      // el admin pueda igual activar a la persona (pasándole el link a mano)
      // mientras el remitente esté en modo sandbox de Resend.
      linkInvitacion: emailEnviado ? undefined : linkInvitacion(token),
    });
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
  password: z.string().min(1).optional(),
});

/** PATCH /api/usuarios/:id — editar rol/estado/nombre o resetear contraseña (solo admin). */
usuariosRouter.patch('/:id', async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });

  const { password, ...resto } = parsed.data;
  if (req.params.id === req.user!.id && resto.activo === false) {
    return res.status(400).json({ error: 'No podés desactivar tu propia cuenta' });
  }
  if (password) {
    const errorPassword = await validarPassword(password);
    if (errorPassword) return res.status(400).json({ error: errorPassword });
  }

  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, val] of Object.entries(resto)) {
    params.push(val);
    sets.push(`${k} = $${params.length}`);
  }
  if (password) {
    params.push(await bcrypt.hash(password, 12));
    sets.push(`password_hash = $${params.length}`);
  }
  // Revoca cualquier sesión activa si cambia algo que afecta el acceso: el
  // rol, la desactivación o la contraseña. Los access tokens ya emitidos
  // dejan de pasar requireAuth de inmediato (ver middleware/rbac.ts); además
  // hay que tumbar las filas de `sesiones` (refresh tokens), si no un refresh
  // token ya emitido seguiría pudiendo canjearse por accesos nuevos.
  const revocaSesiones = 'rol' in resto || resto.activo === false || !!password;
  if (revocaSesiones) {
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
  if (revocaSesiones) await revocarTodasLasSesiones(row.id);
  res.json(row);
});

/** DELETE /api/usuarios/:id — elimina un usuario del panel (solo admin). */
usuariosRouter.delete('/:id', async (req: Request, res: Response) => {
  if (req.params.id === req.user!.id) {
    return res.status(400).json({ error: 'No podés eliminar tu propia cuenta' });
  }
  const [row] = await query('DELETE FROM usuarios WHERE id = $1 RETURNING id', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Usuario inexistente' });
  res.json({ ok: true });
});
