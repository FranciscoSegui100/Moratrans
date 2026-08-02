import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from '../../config/db';
import { env } from '../../config/env';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });

  const { email, password } = parsed.data;
  const rows = await query<{ id: string; email: string; rol: string; password_hash: string; activo: boolean }>(
    'SELECT id, email, rol, password_hash, activo FROM usuarios WHERE email = $1',
    [email],
  );
  const user = rows[0];
  if (!user || !user.activo) return res.status(401).json({ error: 'Credenciales inválidas' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

  const token = jwt.sign({ id: user.id, email: user.email, rol: user.rol }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES as any,
  });
  return res.json({ token, user: { id: user.id, email: user.email, rol: user.rol } });
});
