import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';

export const auditoriaRouter = Router();
auditoriaRouter.use(requireAuth, requireRol('admin'));

const querySchema = z.object({
  tipo: z.string().optional(),
  email: z.string().optional(),
  desde: z.string().optional(),
  hasta: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(100),
  offset: z.coerce.number().min(0).default(0),
});

/** GET /api/auditoria — log de eventos de autenticación de toda la organización (solo admin). */
auditoriaRouter.get('/', async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Parámetros inválidos' });
  const { tipo, email, desde, hasta, limit, offset } = parsed.data;

  const condiciones: string[] = [];
  const params: any[] = [];
  if (tipo) { params.push(tipo); condiciones.push(`tipo = $${params.length}`); }
  if (email) { params.push(`%${email}%`); condiciones.push(`email ILIKE $${params.length}`); }
  if (desde) { params.push(desde); condiciones.push(`creado_en >= $${params.length}`); }
  if (hasta) { params.push(hasta); condiciones.push(`creado_en <= $${params.length}`); }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  params.push(limit);
  params.push(offset);
  const rows = await query(
    `SELECT id, usuario_id, email, tipo, ip, user_agent, detalle, creado_en
     FROM auth_eventos
     ${where}
     ORDER BY creado_en DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(rows);
});
