import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendTemplate } from '../whatsapp/graphApi';

export const pedidosRouter = Router();
pedidosRouter.use(requireAuth);

/**
 * POST /api/pedidos/:id/recordar-pago
 * Envía un recordatorio proactivo con PLANTILLA aprobada por Meta
 * (necesario fuera de la ventana de 24 h). La plantilla `recordatorio_pago`
 * debe existir y estar aprobada en el WhatsApp Manager, con 2 variables:
 *   {{1}} = zona/departamento   {{2}} = precio
 */
pedidosRouter.post('/:id/recordar-pago', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const [pedido] = await query<{ cliente_telefono: string; zona: string; precio: string }>(
    'SELECT cliente_telefono, zona, precio FROM pedidos WHERE id = $1',
    [req.params.id],
  );
  if (!pedido) return res.status(404).json({ error: 'Pedido inexistente' });

  try {
    await sendTemplate(
      pedido.cliente_telefono,
      'recordatorio_pago', // nombre de la plantilla aprobada
      'es_AR',
      [pedido.zona ?? '-', pedido.precio ? `UYU ${pedido.precio}` : '-'],
    );
    res.json({ ok: true });
  } catch (e: any) {
    // Típico si la plantilla no está aprobada o el nombre no coincide.
    res.status(502).json({
      error: 'No se pudo enviar la plantilla. Verificá que "recordatorio_pago" esté aprobada en Meta.',
      detalle: e.response?.data ?? String(e.message),
    });
  }
});
