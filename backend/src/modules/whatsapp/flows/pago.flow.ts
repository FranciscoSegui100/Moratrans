import { query } from '../../../config/db';
import { sendText, sendButtons } from '../graphApi';
import { downloadMedia } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { encrypt, encryptBuffer } from '../../../services/crypto.service';
import { subirArchivo } from '../../../services/storage.service';
import { env } from '../../../config/env';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Datos de la cuenta a la que el cliente tiene que transferir, para
 * mostrarlos ANTES de pedirle el comprobante (nunca después de que ya lo
 * mandó). Vienen de env (PAGO_CBU/PAGO_ALIAS/PAGO_TITULAR_CUENTA, ver
 * env.ts) — así se pueden cambiar sin tocar código. Se usa acá y en
 * cotizacion.flow.ts.
 */
export function datosBancarios(): string {
  return (
    `🏦 *Datos para transferir*\n` +
    `CBU: ${env.PAGO_CBU}\n` +
    `Alias: ${env.PAGO_ALIAS}\n` +
    `Titular: ${env.PAGO_TITULAR_CUENTA}`
  );
}

/**
 * Flujo de pago:
 *  - Si llega imagen/documento -> se descarga vía /media, se guarda en disco
 *    y se registra el pago como 'pendiente'.
 *  - IMPORTANTE: NO se crea ticket ni se reserva contenedor. Eso ocurre
 *    únicamente cuando un operador valida el pago en el panel (fn_validar_pago).
 *  - Tras registrar el comprobante, se pregunta a nombre de quién es la
 *    transferencia (para poder conciliarla) y si necesita factura; si dice
 *    que sí, se avisa al panel para que un operador la cargue.
 */
export async function handlePago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  // Respuesta a "¿A nombre de quién es la transferencia?"
  if (sesion.paso === 'esperando_titular') {
    return manejarTitular(m, sesion);
  }

  // Respuesta a "¿Necesitás factura?"
  if (sesion.paso === 'preguntar_factura') {
    return manejarRespuestaFactura(m, sesion);
  }

  // Si el usuario escribió "Ya pagué" (o "pago"/"pagar"/etc, ver messageRouter)
  // sin adjuntar nada aún: mostrarle los datos para transferir ANTES de
  // pedirle el comprobante.
  if (m.tipo === 'text') {
    await setSesion({ ...sesion, flujo: 'pago', paso: 'esperando_comprobante', contexto: {} });
    await sendText(
      to,
      `${datosBancarios()}\n\n` +
        '💸 Transferí y mandame por acá la *foto o PDF* del comprobante (o escribí *Ya pagué* cuando lo hayas hecho, si preferís avisarme antes).\n\n' +
        '_Escribí *menú* si te arrepentiste y querés volver al inicio._',
    );
    return;
  }

  if (m.tipo !== 'image' && m.tipo !== 'document') {
    await sendText(to, '📎 Necesito una imagen o PDF del comprobante para poder registrarlo. ¿Podés reenviarlo?');
    return;
  }

  try {
    // 1) Descargar el media desde la Graph API y guardarlo en Supabase Storage
    // (no en disco: el filesystem de Railway es efímero y se pierde en cada redeploy).
    // El contenido se cifra ANTES de subirlo (sección 9): el bucket de un
    // tercero nunca guarda el binario en claro, ni siquiera si su config de
    // privacidad fallara — solo la referencia cifrada vive en la DB (abajo).
    const { buffer, mime } = await downloadMedia(m.mediaId!);
    const ext = mime.includes('pdf') ? 'pdf' : mime.split('/')[1] || 'jpg';
    const filename = `${to}_${Date.now()}.${ext}`;
    const rutaStorage = `comprobantes/${filename}`;
    await subirArchivo(encryptBuffer(buffer), rutaStorage, 'application/octet-stream');

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
    //    Si ya hay un pago pendiente para el mismo pedido, este comprobante
    //    se agrega como adjunto de esa misma solicitud en vez de duplicar el
    //    registro y la alerta de validación (sección 23, caso borde de
    //    comprobante duplicado).
    const pedidoId = pedido[0]?.id ?? null;
    const rutaCifrada = encrypt(rutaStorage);

    let pendienteId: string | null = null;
    if (pedidoId) {
      const [pendiente] = await query<{ id: string }>(
        `SELECT id FROM pagos WHERE pedido_id = $1 AND estado = 'pendiente' ORDER BY creado_en DESC LIMIT 1`,
        [pedidoId],
      );
      pendienteId = pendiente?.id ?? null;
    }
    const esAdjunto = pendienteId !== null;

    let pagoId: string;
    if (esAdjunto) {
      pagoId = pendienteId as string;
      await query(
        `INSERT INTO pagos_adjuntos (pago_id, url_comprobante, media_id) VALUES ($1,$2,$3)`,
        [pagoId, rutaCifrada, m.mediaId],
      );
      // Este INSERT viene del webhook, no de la API del panel: no pasa por
      // broadcastCambios, así que la pestaña Pagos quedaba desactualizada
      // hasta hacer F5 (igual criterio que chofer.flow.ts).
      emitRecursoActualizado('pagos');
    } else {
      const [pago] = await query<{ id: string }>(
        `INSERT INTO pagos (cliente_telefono, pedido_id, url_comprobante, media_id, estado)
         VALUES ($1,$2,$3,$4,'pendiente')
         RETURNING id`,
        [to, pedidoId, rutaCifrada, m.mediaId],
      );
      pagoId = pago.id;
    }

    // 4) Alerta para el panel + push en tiempo real. Si es un adjunto de un
    //    pago que ya tenía alerta abierta, el ON CONFLICT la deja como está
    //    (mismo pagoId = misma referencia_id) en vez de duplicarla.
    //    Se enriquece con los datos del pago/pedido para que el operador pueda
    //    ver el comprobante y decidir (validar/rechazar) sin salir de la bandeja.
    const [alerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('pago_pendiente_validacion', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [pagoId, `Nuevo comprobante de ${to} pendiente de validar`],
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
      esAdjunto
        ? '✅ ¡Recibido! Sumamos este comprobante a tu solicitud que ya estaba *pendiente de validación*.\n' +
          'En cuanto la confirmemos te mandamos el *ticket* con el contenedor asignado. 📦\n\n' +
          '_Si en un rato no tenés novedades, escribí *asesor*._'
        : '✅ ¡Recibido! Tu comprobante quedó *pendiente de validación* por un operador.\n' +
          'En cuanto lo confirmemos te mandamos el *ticket* con el contenedor asignado. 📦\n\n' +
          '_Si en un rato no tenés novedades, escribí *asesor*._',
    );

    // 6) A nombre de quién es la transferencia (para poder conciliarla) —
    //    solo se pregunta una vez por solicitud: si es un adjunto de una
    //    solicitud que ya pasó por acá, se salta directo a la pregunta de
    //    factura en vez de repetirla.
    if (esAdjunto) {
      await preguntarFactura(to, pagoId);
    } else {
      await setSesion({ telefono: to, flujo: 'pago', paso: 'esperando_titular', contexto: { pagoId } });
      await sendText(to, '🙋 ¿A nombre de quién es la transferencia?');
    }
  } catch (err) {
    console.error('Error en flujo de pago:', err);
    await sendText(to, '⚠️ Tuvimos un problema al procesar el comprobante. Probá reenviarlo en unos minutos.');
  }
}

/** Maneja la respuesta a "¿A nombre de quién es la transferencia?". */
async function manejarTitular(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const pagoId = sesion.contexto?.pagoId as string | undefined;
  if (!pagoId) {
    await clearSesion(to);
    return;
  }

  const titular = (m.texto ?? '').trim();
  if (m.tipo !== 'text' || titular.length < 2) {
    await sendText(to, '🙋 Decime el nombre (persona o empresa) a nombre de quién hiciste la transferencia.');
    return;
  }

  await query('UPDATE pagos SET titular_transferencia = $1 WHERE id = $2', [titular, pagoId]);
  await preguntarFactura(to, pagoId);
}

/** Pregunta si necesita factura (la carga un operador desde el panel). */
async function preguntarFactura(to: string, pagoId: string): Promise<void> {
  await setSesion({ telefono: to, flujo: 'pago', paso: 'preguntar_factura', contexto: { pagoId } });
  await sendButtons(to, '🧾 ¿Necesitás que te mandemos la factura?', [
    { id: 'factura_si', title: '🧾 Sí, quiero' },
    { id: 'factura_no', title: '👍 No, gracias' },
  ]);
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
