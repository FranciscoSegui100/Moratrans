import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';

export const ticketsRouter = Router();
ticketsRouter.use(requireAuth);

/** GET /api/tickets?estado=activo */
ticketsRouter.get('/', async (req: Request, res: Response) => {
  const estado = (req.query.estado as string) || 'activo';
  const rows = await query(
    `SELECT t.id, t.estado, t.contenedor_numero, t.creado_en, t.cerrado_en,
            pe.zona, p.cliente_telefono
       FROM tickets t
       LEFT JOIN pedidos pe ON pe.id = t.pedido_id
       LEFT JOIN pagos  p  ON p.id  = t.pago_id
      WHERE t.estado = $1 ORDER BY t.creado_en DESC`,
    [estado],
  );
  res.json(rows);
});

/**
 * POST /api/tickets/:id/cerrar — cierra el ticket al finalizar el servicio
 * y libera el contenedor si corresponde (retirado -> disponible).
 */
ticketsRouter.post('/:id/cerrar', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const [ticket] = await query<{ contenedor_numero: string }>(
    `UPDATE tickets SET estado = 'cerrado', cerrado_en = now()
      WHERE id = $1 AND estado = 'activo'
      RETURNING contenedor_numero`,
    [req.params.id],
  );
  if (!ticket) return res.status(409).json({ error: 'Ticket inexistente o ya cerrado' });

  // Si el contenedor ya fue retirado, se libera a disponible (transición válida).
  await query(
    `UPDATE contenedores SET estado = 'disponible', actualizado_por = 'cierre_ticket'
      WHERE numero = $1 AND estado = 'retirado'`,
    [ticket.contenedor_numero],
  ).catch(() => {}); // si no está en 'retirado', el trigger rechaza; lo ignoramos

  res.json({ ok: true });
});
