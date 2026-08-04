import fs from 'fs';
import path from 'path';
import { query } from '../../../config/db';
import { env } from '../../../config/env';
import { sendText, sendButtons } from '../graphApi';
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
 *  - Tras registrar el comprobante, se le pregunta al cliente si necesita
 *    factura; si dice que sí, se avisa al panel para que un operador la cargue.
 */
export async function handlePago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  // Respuesta a "¿Necesitás factura?"
  if (sesion.paso === 'preguntar_factura') {
    return manejarRespuestaFactura(m, sesion);
  }

  // Si el usuario escribió "Ya pagué" sin adjuntar nada aún:
  if (m.tipo === 'text') {
    await setSesion({ ...sesion, flujo: 'pago', paso: 'esperando_comprobante', contexto: {} });
    await sendText(
      to,
      '💸 ¡Genial! Enviame la *foto o PDF* del comprobante de transferencia y lo registro para validación.\n\n' +
        '_Escribí *menú* si te arrepentiste y querés volver al inicio._',
    );
    return;
  }

  if (m.tipo !== 'image' && m.tipo !== 'document') {
    await sendText(to, '📎 Necesito una imagen o PDF del comprobante para poder registrarlo. ¿Podés reenviarlo?');
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
    const pedido = await query<{ id: string; zona: string; precio: string; moneda: string | null }>(
      `SELECT pe.id, pe.zona, pe.precio, td.moneda
         FROM pedidos pe
         LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
        WHERE pe.cliente_telefono = $1 AND pe.estado IN ('cotizado','confirmado')
        ORDER BY pe.creado_en DESC LIMIT 1`,
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

    // 4) Alerta para el panel + push en tiempo real.
    //    Se enriquece con los datos del pago/pedido para que el operador pueda
    //    ver el comprobante y decidir (validar/rechazar) sin salir de la bandeja.
    const [alerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('pago_pendiente_validacion', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [pago.id, `Nuevo comprobante de ${to} pendiente de validar`],
    );
    if (alerta) {
      emitAlerta({
        ...alerta,
        cliente_telefono: to,
        monto: null,
        pago_estado: 'pendiente',
        tiene_comprobante: true,
        zona: pedido[0]?.zona ?? null,
        precio: pedido[0]?.precio ?? null,
        moneda: pedido[0]?.moneda ?? null,
      });
    }

    // 5) Confirmar al cliente (sin prometer reserva automática)
    await sendText(
      to,
      '✅ ¡Recibido! Tu comprobante quedó *pendiente de validación* por un operador.\n' +
        'En cuanto lo confirmemos te mandamos el *ticket* con el contenedor asignado. 📦\n\n' +
        '_Si en un rato no tenés novedades, escribí *asesor*._',
    );

    // 6) Preguntar si necesita factura (la carga un operador desde el panel).
    await setSesion({ telefono: to, flujo: 'pago', paso: 'preguntar_factura', contexto: { pagoId: pago.id } });
    await sendButtons(to, '🧾 ¿Necesitás que te mandemos la factura?', [
      { id: 'factura_si', title: '🧾 Sí, quiero' },
      { id: 'factura_no', title: '👍 No, gracias' },
    ]);
  } catch (err) {
    console.error('Error en flujo de pago:', err);
    await sendText(to, '⚠️ Tuvimos un problema al procesar el comprobante. Probá reenviarlo en unos minutos.');
  }
}

/** Maneja la respuesta a "¿Necesitás factura?" tras registrar el comprobante. */
async function manejarRespuestaFactura(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const pagoId = sesion.contexto?.pagoId as string | undefined;
  const t = (m.texto ?? '').toLowerCase();
  const quiere = m.seleccionId === 'factura_si' || (m.seleccionId !== 'factura_no' && t.includes('si') && !t.includes('no'));

  if (quiere && pagoId) {
    const [alerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('factura_solicitada', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [pagoId, `${to} pidió factura del pago ${pagoId}`],
    );
    if (alerta) emitAlerta({ ...alerta, cliente_telefono: to });
    await clearSesion(to);
    await sendText(to, '🧾 ¡Perfecto! Ya avisamos al equipo — te la mandamos por acá en cuanto esté lista.');
    return;
  }

  await clearSesion(to);
  await sendText(to, '👍 ¡Listo! Cualquier cosa, escribí *menú*.');
}
