import express, { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { query } from '../../config/db';
import { env } from '../../config/env';
import { requireAuth, requireRol, puedeVerComprobante } from '../../middleware/rbac';
import { encrypt, decrypt } from '../../services/crypto.service';
import { enviarTicketPorWhatsApp } from '../../services/pdf.service';
import { sendText, uploadMedia, sendDocument } from '../whatsapp/graphApi';
import { emitAlerta } from '../../config/socket';

export const pagosRouter = Router();
pagosRouter.use(requireAuth);

/** GET /api/pagos?estado=pendiente — lista de pagos (comprobante enmascarado por rol). */
pagosRouter.get('/', async (req: Request, res: Response) => {
  const estado = (req.query.estado as string) || 'pendiente';
  const rows = await query(
    `SELECT p.id, p.cliente_telefono, p.monto, p.url_comprobante, p.estado, p.creado_en,
            pe.zona, pe.precio, td.moneda
       FROM pagos p
       LEFT JOIN pedidos pe ON pe.id = p.pedido_id
       LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
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
 * GET /api/pagos/:id/comprobante — sirve el archivo del comprobante.
 * Mismo criterio de acceso que el campo url_comprobante (admin/finanzas):
 * NO se monta como estático para no saltear el RBAC.
 */
pagosRouter.get('/:id/comprobante', requireRol('admin', 'finanzas'), async (req: Request, res: Response) => {
  const [pago] = await query<{ url_comprobante: string | null }>(
    'SELECT url_comprobante FROM pagos WHERE id = $1',
    [req.params.id],
  );
  if (!pago?.url_comprobante) return res.status(404).json({ error: 'Comprobante no encontrado' });

  // basename() evita path traversal aunque el valor descifrado sea de confianza (defensa en profundidad).
  const filename = path.basename(decrypt(pago.url_comprobante));
  const filePath = path.resolve(env.MEDIA_DIR, 'comprobantes', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en el servidor' });

  res.sendFile(filePath);
});

const validarSchema = z.object({
  diasDemora: z.coerce.number().int().min(0).optional(),
  choferId: z.string().uuid().optional(),
  venceEn: z.string().optional(), // fecha (YYYY-MM-DD) en la que vence/hay que retirar el contenedor
});

/**
 * POST /api/pagos/:id/validar — SÓLO operador/admin/finanzas.
 * Llama a fn_validar_pago (atómico): reserva contenedor + crea ticket.
 * Opcionalmente, el operador indica cuántos días va a demorar el retiro,
 * qué chofer queda asignado a la entrega y la fecha de vencimiento del
 * contenedor — se registra un viaje de entrega y se avisa al cliente.
 * Luego genera y envía el PDF por WhatsApp.
 */
pagosRouter.post('/:id/validar', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const pagoId = req.params.id;
  const parsed = validarSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { diasDemora, choferId, venceEn } = parsed.data;

  try {
    const [result] = await query<{ ticket_id: string; contenedor: string }>(
      'SELECT * FROM fn_validar_pago($1, $2)',
      [pagoId, req.user!.id],
    );

    // Datos para el ticket
    const [info] = await query<{ cliente_telefono: string; zona: string; precio: string; moneda: string | null }>(
      `SELECT p.cliente_telefono, pe.zona, pe.precio, td.moneda
         FROM pagos p
         LEFT JOIN pedidos pe ON pe.id = p.pedido_id
         LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
        WHERE p.id = $1`,
      [pagoId],
    );

    if (venceEn) {
      await query('UPDATE contenedores SET vence_en = $1 WHERE numero = $2', [venceEn, result.contenedor]);
    }
    if (choferId) {
      await query(
        `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, cliente_telefono, zona, estado, notas)
         VALUES ('entrega', COALESCE($1, CURRENT_DATE), $2, $3, $4, $5, 'programado', 'Asignado al validar el pago')`,
        [venceEn ?? null, choferId, result.contenedor, info?.cliente_telefono ?? null, info?.zona ?? null],
      );
    }
    if (diasDemora != null) {
      sendText(
        info.cliente_telefono,
        `📅 Tu contenedor se pasará a recoger en *${diasDemora} día${diasDemora === 1 ? '' : 's'}* desde la entrega del mismo.`,
      ).catch((e) => console.error('Error avisando plazo de retiro:', e));
    }

    // Envío del PDF (no bloqueante para la respuesta HTTP)
    enviarTicketPorWhatsApp({
      ticketId: result.ticket_id,
      contenedor: result.contenedor,
      zona: info?.zona ?? '—',
      precio: info?.precio,
      moneda: info?.moneda ?? undefined,
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

  sendText(
    pago.cliente_telefono,
    `⚠️ Tu comprobante no pudo validarse. Motivo: ${motivo}\n\n` +
      'Escribí *Ya pagué* y enviá el comprobante de nuevo (probá con buena luz y que se lea bien el monto y la fecha) 📎',
  ).catch((e) => console.error(e));

  res.json({ ok: true });
});

/**
 * POST /api/pagos/:id/factura?filename=xxx.pdf — el operador carga la factura
 * (cuando el cliente la pidió tras el flujo de "Ya pagué") y se la reenviamos
 * por WhatsApp. El archivo viaja en el body crudo (no es un form-data); el
 * frontend manda el File directamente con su Content-Type real.
 */
pagosRouter.post(
  '/:id/factura',
  requireRol('admin', 'operador', 'finanzas'),
  express.raw({ type: () => true, limit: '10mb' }),
  async (req: Request, res: Response) => {
    const buffer = req.body as Buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Archivo vacío o inválido' });
    }

    const [pago] = await query<{ cliente_telefono: string }>(
      'SELECT cliente_telefono FROM pagos WHERE id = $1',
      [req.params.id],
    );
    if (!pago) return res.status(404).json({ error: 'Pago inexistente' });

    const contentType = req.header('content-type') || 'application/octet-stream';
    const nombreOriginal = (req.query.filename as string) || `factura.${contentType.includes('pdf') ? 'pdf' : 'jpg'}`;
    const ext = path.extname(nombreOriginal) || (contentType.includes('pdf') ? '.pdf' : '.jpg');

    const dir = path.resolve(env.MEDIA_DIR, 'facturas');
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${req.params.id}_${Date.now()}${ext}`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);

    await query('UPDATE pagos SET factura_url = $2 WHERE id = $1', [
      req.params.id,
      encrypt(`/storage/facturas/${filename}`),
    ]);
    await query(
      `UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'factura_solicitada' AND referencia_id = $1`,
      [req.params.id],
    );

    try {
      const mediaId = await uploadMedia(filePath, contentType);
      await sendDocument(pago.cliente_telefono, mediaId, `factura${ext}`, '🧾 ¡Acá tenés tu factura!');
    } catch (e) {
      console.error('Error enviando factura por WhatsApp:', e);
      return res.status(502).json({ error: 'La factura se guardó pero no se pudo enviar por WhatsApp' });
    }

    res.json({ ok: true });
  },
);
