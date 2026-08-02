import fs from 'fs';
import path from 'path';
import { query } from '../../../config/db';
import { env } from '../../../config/env';
import { sendText } from '../graphApi';
import { downloadMedia } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta } from '../../../config/socket';
import { encrypt } from '../../../services/crypto.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Flujo de pago:
 *  - Si llega imagen/documento -> se descarga vía /media, se guarda en disco
 *    y se registra el pago como 'pendiente'.
 *  - IMPORTANTE: NO se crea ticket ni se reserva contenedor. Eso ocurre
 *    únicamente cuando un operador valida el pago en el panel (fn_validar_pago).
 */
export async function handlePago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  // Si el usuario escribió "pagar" sin adjuntar nada aún:
  if (m.tipo === 'text') {
    await setSesion({ ...sesion, flujo: 'pago', paso: 'esperando_comprobante', contexto: {} });
    await sendText(
      to,
      '💳 Perfecto. Enviá una *foto o PDF* del comprobante de transferencia y lo registramos para validación.',
    );
    return;
  }

  if (m.tipo !== 'image' && m.tipo !== 'document') {
    await sendText(to, 'Necesito una imagen o PDF del comprobante. Probá de nuevo, por favor.');
    return;
  }

  try {
    // 1) Descargar el media desde la Graph API
    const { buffer, mime } = await downloadMedia(m.mediaId!);
    const ext = mime.includes('pdf') ? 'pdf' : mime.split('/')[1] || 'jpg';
    const dir = path.resolve(env.MEDIA_DIR, 'comprobantes');
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${to}_${Date.now()}.${ext}`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);

    // 2) Vincular al último pedido cotizado/confirmado del cliente (si existe)
    const pedido = await query<{ id: string }>(
      `SELECT id FROM pedidos
        WHERE cliente_telefono = $1 AND estado IN ('cotizado','confirmado')
        ORDER BY creado_en DESC LIMIT 1`,
      [to],
    );

    // 3) Registrar el pago como PENDIENTE (no se crea ticket).
    //    La ruta del comprobante se guarda CIFRADA en reposo.
    const rutaCifrada = encrypt(`/storage/comprobantes/${filename}`);
    const [pago] = await query<{ id: string }>(
      `INSERT INTO pagos (cliente_telefono, pedido_id, url_comprobante, media_id, estado)
       VALUES ($1,$2,$3,$4,'pendiente')
       RETURNING id`,
      [to, pedido[0]?.id ?? null, rutaCifrada, m.mediaId],
    );

    // 4) Alerta para el panel + push en tiempo real
    const [alerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('pago_pendiente_validacion', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, creado_en`,
      [pago.id, `Nuevo comprobante de ${to} pendiente de validar`],
    );
    if (alerta) emitAlerta(alerta);

    // 5) Confirmar al cliente (sin prometer reserva automática)
    await sendText(
      to,
      '✅ Recibimos tu comprobante. Está *pendiente de validación* por un operador.\n' +
        'Cuando lo confirmemos, te enviamos el *ticket* con el contenedor asignado.',
    );
    await clearSesion(to);
  } catch (err) {
    console.error('Error en flujo de pago:', err);
    await sendText(to, 'Tuvimos un problema al procesar el comprobante. Reintentá en unos minutos.');
  }
}
