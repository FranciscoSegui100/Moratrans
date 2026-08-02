import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth } from '../../middleware/rbac';

export const alertasRouter = Router();
alertasRouter.use(requireAuth);

/** GET /api/alertas?estado=nueva */
alertasRouter.get('/', async (req: Request, res: Response) => {
  const estado = req.query.estado as string | undefined;
  const rows = estado
    ? await query('SELECT * FROM alertas WHERE estado = $1 ORDER BY creado_en DESC', [estado])
    : await query("SELECT * FROM alertas WHERE estado <> 'resuelta' ORDER BY creado_en DESC");
  res.json(rows);
});

/** PATCH /api/alertas/:id — cambia estado (vista/resuelta). */
alertasRouter.patch('/:id', async (req: Request, res: Response) => {
  const estado = req.body?.estado as string;
  if (!['nueva', 'vista', 'resuelta'].includes(estado))
    return res.status(400).json({ error: 'Estado inválido' });
  const [row] = await query('UPDATE alertas SET estado = $1 WHERE id = $2 RETURNING *', [estado, req.params.id]);
  res.json(row);
});
