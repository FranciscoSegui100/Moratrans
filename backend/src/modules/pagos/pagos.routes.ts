import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth, requireRol, puedeVerComprobante } from '../../middleware/rbac';
import { decrypt } from '../../services/crypto.service';
import { enviarTicketPorWhatsApp } from '../../services/pdf.service';
import { sendText } from '../whatsapp/graphApi';
import { emitAlerta } from '../../config/socket';

export const pagosRouter = Router();
pagosRouter.use(requireAuth);

/** GET /api/pagos?estado=pendiente — lista de pagos (comprobante enmascarado por rol). */
pagosRouter.get('/', async (req: Request, res: Response) => {
  const estado = (req.query.estado as string) || 'pendiente';
  const rows = await query(
    `SELECT p.id, p.cliente_telefono, p.monto, p.url_comprobante, p.estado, p.creado_en,
            pe.zona, pe.precio
       FROM pagos p LEFT JOIN pedidos pe ON pe.id = p.pedido_id
      WHERE p.estado = $1 ORDER BY p.creado_en DESC`,
    [estado],
  );
  const rol = req.user!.rol;
  res.json(
    rows.map((r: any) => ({
      ...r,
      // Comprobante: se descifra solo si el rol puede verlo; si no, null.
      url_comprobante: puedeVerComprobante(rol) ? decrypt(r.url_comprobante) : null,
    })),
  );
});

/**
 * POST /api/pagos/:id/validar — SÓLO operador/admin/finanzas.
 * Llama a fn_validar_pago (atómico): reserva contenedor + crea ticket.
 * Luego genera y envía el PDF por WhatsApp.
 */
pagosRouter.post('/:id/validar', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const pagoId = req.params.id;
  try {
    const [result] = await query<{ ticket_id: string; contenedor: string }>(
      'SELECT * FROM fn_validar_pago($1, $2)',
      [pagoId, req.user!.id],
    );

    // Datos para el ticket
    const [info] = await query<{ cliente_telefono: string; zona: string; precio: string }>(
      `SELECT p.cliente_telefono, pe.zona, pe.precio
         FROM pagos p LEFT JOIN pedidos pe ON pe.id = p.pedido_id WHERE p.id = $1`,
      [pagoId],
    );

    // Envío del PDF (no bloqueante para la respuesta HTTP)
    enviarTicketPorWhatsApp({
      ticketId: result.ticket_id,
      contenedor: result.contenedor,
      zona: info?.zona ?? '—',
      precio: info?.precio,
      clienteTelefono: info.cliente_telefono,
      fecha: new Date(),
    }).catch((e) => console.error('Error enviando ticket:', e));

    res.json({ ok: true, ticket_id: result.ticket_id, contenedor: result.contenedor });
  } catch (e: any) {
    // p.ej. "No hay contenedores disponibles" -> genera alerta de stock
    if (String(e.message).includes('No hay contenedores')) {
      const [al] = await query(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('stock_bajo', $1, 'Sin contenedores disponibles al validar pago')
         ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
         RETURNING id, tipo, referencia_id, mensaje, creado_en`,
        [pagoId],
      );
      if (al) emitAlerta(al);
    }
    res.status(409).json({ error: e.message });
  }
});

/** POST /api/pagos/:id/rechazar — marca rechazado y avisa al cliente. */
pagosRouter.post('/:id/rechazar', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const motivo = (req.body?.motivo as string) || 'Comprobante no válido';
  const [pago] = await query<{ cliente_telefono: string }>(
    `UPDATE pagos SET estado = 'rechazado', motivo_rechazo = $2, validado_por = $3
      WHERE id = $1 AND estado = 'pendiente' RETURNING cliente_telefono`,
    [req.params.id, motivo, req.user!.id],
  );
  if (!pago) return res.status(409).json({ error: 'Pago inexistente o ya procesado' });

  await query(`UPDATE alertas SET estado = 'resuelta'
               WHERE tipo = 'pago_pendiente_validacion' AND referencia_id = $1`, [req.params.id]);

  sendText(pago.cliente_telefono, `❌ Tu comprobante fue rechazado. Motivo: ${motivo}. Podés reenviarlo.`)
    .catch((e) => console.error(e));

  res.json({ ok: true });
});
