import { query } from '../../../config/db';
import { sendText, sendButtons, sendList } from '../graphApi';
import { downloadMedia } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { encrypt, encryptBuffer } from '../../../services/crypto.service';
import { subirArchivo } from '../../../services/storage.service';
import { obtenerOCrearCliente } from '../../../services/clientes.service';
import { env } from '../../../config/env';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

type PedidoCandidato = { id: string; zona: string; precio: string; moneda: string | null };

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
 *  - El comprobante se vincula al pedido cotizado/confirmado del cliente. Si
 *    tiene más de uno abierto a la vez, no se puede asumir cuál está pagando
 *    -> se le pregunta antes de registrar nada; si tiene uno solo (el caso
 *    normal), sigue derecho sin pedirle nada extra.
 *  - Tras registrar el comprobante, se pregunta a nombre de quién es la
 *    transferencia (para poder conciliarla) y si necesita factura; si dice
 *    que sí, se avisa al panel para que un operador la cargue.
 */
export async function handlePago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  // Respuesta a "¿Cómo vas a pagar?"
  if (sesion.paso === 'elegir_metodo_pago') {
    return manejarMetodoPago(m, sesion);
  }

  // Respuesta a "¿Para cuál cotización es este comprobante?"
  if (sesion.paso === 'elegir_pedido') {
    return manejarEleccionPedido(m, sesion);
  }

  // Respuesta a "¿Para cuál cotización es este pago a cuenta corriente?"
  if (sesion.paso === 'elegir_pedido_cc') {
    return manejarEleccionPedidoCC(m, sesion);
  }

  // Respuesta a "¿A nombre de quién es la transferencia?"
  if (sesion.paso === 'esperando_titular') {
    return manejarTitular(m, sesion);
  }

  // Respuesta a "¿Necesitás factura?"
  if (sesion.paso === 'preguntar_factura') {
    return manejarRespuestaFactura(m, sesion);
  }

  // Si el usuario escribió "Ya pagué" (o "pago"/"pagar"/etc, ver messageRouter)
  // sin adjuntar nada aún: antes de pedirle el comprobante, preguntamos cómo
  // va a pagar — pero "Cuenta corriente" solo se ofrece a quien ya la tiene
  // *aprobada*; para el resto es directo por transferencia (la cuenta
  // corriente se habilita aparte, no se autopide desde acá).
  if (m.tipo === 'text') {
    await setSesion({ ...sesion, flujo: 'pago', paso: 'elegir_metodo_pago', contexto: {} });
    await sendButtons(to, '💳 ¿Cómo vas a pagar?', await opcionesMetodoPago(to));
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
    // privacidad fallara — solo la referencia cifrada vive en la DB.
    const { buffer, mime } = await downloadMedia(m.mediaId!);
    const ext = mime.includes('pdf') ? 'pdf' : mime.split('/')[1] || 'jpg';
    const filename = `${to}_${Date.now()}.${ext}`;
    const rutaStorage = `comprobantes/${filename}`;
    await subirArchivo(encryptBuffer(buffer), rutaStorage, 'application/octet-stream');
    const rutaCifrada = encrypt(rutaStorage);
    const mediaId = m.mediaId ?? null;

    // 2) ¿A qué pedido corresponde? Si el cliente tiene más de una cotización
    // abierta a la vez, no lo podemos asumir por orden cronológico solo —
    // se lo preguntamos y recién ahí seguimos (el comprobante ya está subido,
    // solo falta decidir a qué pedido atarlo).
    const pedidos = await pedidosAbiertos(to);

    if (pedidos.length > 1) {
      await setSesion({
        telefono: to,
        flujo: 'pago',
        paso: 'elegir_pedido',
        contexto: { rutaCifrada, mediaId },
      });
      await sendList(
        to,
        '¿Para cuál es este comprobante?',
        'Tenés más de una cotización activa — decime a cuál corresponde este pago:',
        'Ver cotizaciones',
        pedidos.map((p) => ({
          id: `pedido:${p.id}`,
          title: p.zona,
          description: `${p.moneda ?? ''} ${Number(p.precio).toLocaleString('es-AR')}`.trim(),
        })),
      );
      return;
    }

    await registrarComprobante(to, rutaCifrada, mediaId, pedidos[0]);
  } catch (err) {
    console.error('Error en flujo de pago:', err);
    await sendText(to, '⚠️ Tuvimos un problema al procesar el comprobante. Probá reenviarlo en unos minutos.');
  }
}

/**
 * ¿Este teléfono ya tiene cuenta corriente aprobada? Se usa para decidir si
 * se le ofrece esa opción de pago — un cliente ocasional no la ve, solo
 * transferencia (la cuenta corriente se habilita aparte, ej. desde el panel
 * de Clientes, no autopidiéndola desde este flujo).
 */
export async function tieneCuentaCorrienteAprobada(telefono: string): Promise<boolean> {
  const [cliente] = await query<{ cuenta_corriente_estado: string }>(
    'SELECT cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [telefono],
  );
  return cliente?.cuenta_corriente_estado === 'aprobada';
}

/** Botones de "¿Cómo vas a pagar?" — Cuenta corriente solo si ya está aprobada. */
export async function opcionesMetodoPago(telefono: string): Promise<{ id: string; title: string }[]> {
  const opciones = [{ id: 'metodo_transferencia', title: '💸 Transferencia' }];
  if (await tieneCuentaCorrienteAprobada(telefono)) {
    opciones.push({ id: 'metodo_cuenta_corriente', title: '📋 Cuenta corriente' });
  }
  return opciones;
}

/** Pedidos abiertos (cotizados o confirmados) de un teléfono, más recientes primero. */
async function pedidosAbiertos(telefono: string): Promise<PedidoCandidato[]> {
  return query<PedidoCandidato>(
    `SELECT pe.id, pe.zona, pe.precio, td.moneda
       FROM pedidos pe
       LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
      WHERE pe.cliente_telefono = $1 AND pe.estado IN ('cotizado','confirmado')
      ORDER BY pe.creado_en DESC LIMIT 10`,
    [telefono],
  );
}

/** Maneja la respuesta a "¿Cómo vas a pagar?". */
async function manejarMetodoPago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (m.seleccionId === 'metodo_cuenta_corriente') {
    // Defensa además de ocultar el botón: si llega igual (ej. un botón viejo
    // en el chat de alguien que ya no la tiene), no se lo dejamos pasar.
    if (!(await tieneCuentaCorrienteAprobada(to))) {
      await sendButtons(to, 'Esa opción no está disponible para vos — elegí transferencia. 👇', await opcionesMetodoPago(to));
      return;
    }
    return iniciarCuentaCorriente(m);
  }

  if (m.seleccionId === 'metodo_transferencia') {
    await setSesion({ ...sesion, flujo: 'pago', paso: 'esperando_comprobante', contexto: {} });
    await sendText(
      to,
      `${datosBancarios()}\n\n` +
        '💸 Transferí y mandame por acá la *foto o PDF* del comprobante.\n\n' +
        '_Escribí *menú* si te arrepentiste y querés volver al inicio._',
    );
    return;
  }

  await sendButtons(to, 'Elegí una de las opciones de abajo. 👇', await opcionesMetodoPago(to));
}

/**
 * El cliente eligió pagar contra su cuenta corriente. Igual que con un
 * comprobante, primero hay que saber a qué cotización corresponde (si tiene
 * más de una abierta se le pregunta). No se le exige nada más: la confianza
 * (aprobar o no la cuenta corriente) la resuelve un operador desde el panel,
 * ver POST /api/pagos/:id/validar.
 */
async function iniciarCuentaCorriente(m: MensajeEntrante): Promise<void> {
  const to = m.from;
  await obtenerOCrearCliente(to, m.nombrePerfil).catch((e) => console.error('Error dando de alta al cliente:', e));

  const pedidos = await pedidosAbiertos(to);
  if (pedidos.length > 1) {
    await setSesion({ telefono: to, flujo: 'pago', paso: 'elegir_pedido_cc', contexto: {} });
    await sendList(
      to,
      '¿Para cuál es este pago a cuenta corriente?',
      'Tenés más de una cotización activa — decime a cuál corresponde:',
      'Ver cotizaciones',
      pedidos.map((p) => ({
        id: `pedido:${p.id}`,
        title: p.zona,
        description: `${p.moneda ?? ''} ${Number(p.precio).toLocaleString('es-AR')}`.trim(),
      })),
    );
    return;
  }

  await registrarCuentaCorriente(to, pedidos[0]);
}

/** Maneja la respuesta a "¿Para cuál cotización es este pago a cuenta corriente?". */
async function manejarEleccionPedidoCC(m: MensajeEntrante, _sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'interactive_list' || !m.seleccionId?.startsWith('pedido:')) {
    await sendText(to, 'Por favor, elegí una de las cotizaciones de la lista de arriba. 👆\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  const pedidoId = m.seleccionId.replace('pedido:', '');
  const [pedido] = await query<PedidoCandidato>(
    `SELECT pe.id, pe.zona, pe.precio, td.moneda
       FROM pedidos pe
       LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
      WHERE pe.id = $1 AND pe.cliente_telefono = $2`,
    [pedidoId, to],
  );
  if (!pedido) {
    await clearSesion(to);
    await sendText(to, '🙁 Esa cotización ya no está disponible. Escribí *menú* para volver a empezar.');
    return;
  }
  await registrarCuentaCorriente(to, pedido);
}

/**
 * Registra el pago a cuenta corriente (sin comprobante) y alerta al panel.
 * Levanta 'cuenta_corriente_solicitada' en vez de 'pago_pendiente_validacion'
 * — es una decisión de confianza distinta a revisar un comprobante — pero
 * comparte referencia_id = pago.id, así que ambas las resuelve
 * fn_validar_pago al validar (ver migración 0013).
 */
async function registrarCuentaCorriente(to: string, pedido: PedidoCandidato | undefined): Promise<void> {
  const [pago] = await query<{ id: string }>(
    `INSERT INTO pagos (cliente_telefono, pedido_id, estado, es_cuenta_corriente)
     VALUES ($1,$2,'pendiente',TRUE) RETURNING id`,
    [to, pedido?.id ?? null],
  );

  const [cliente] = await query<{ cuenta_corriente_estado: string }>(
    'SELECT cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [to],
  );
  if (cliente?.cuenta_corriente_estado === 'sin_pedir') {
    await query(`UPDATE clientes SET cuenta_corriente_estado = 'pendiente' WHERE telefono = $1`, [to]);
  }

  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('cuenta_corriente_solicitada', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [pago.id, `${to} pidió pagar a cuenta corriente`],
  );
  if (alerta) {
    emitAlerta({
      ...alerta,
      cliente_telefono: to,
      monto: null,
      pago_estado: 'pendiente',
      tiene_comprobante: false,
      zona: pedido?.zona ?? null,
      precio: pedido?.precio ?? null,
      moneda: pedido?.moneda ?? null,
    });
  }

  await clearSesion(to);
  await sendText(
    to,
    cliente?.cuenta_corriente_estado === 'aprobada'
      ? '✅ ¡Listo! Quedó registrado a tu cuenta corriente. En cuanto lo confirmemos te mandamos el *ticket* con el contenedor asignado. 📦'
      : '📋 Anotado. Tu cuenta corriente todavía tiene que aprobarla un operador — en cuanto la revisen seguimos con tu pedido.\n\n' +
        '_Si en un rato no tenés novedades, escribí *asesor*._',
  );
}

/** Maneja la respuesta a "¿Para cuál cotización es este comprobante?". */
async function manejarEleccionPedido(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const rutaCifrada = sesion.contexto?.rutaCifrada as string | undefined;
  const mediaId = (sesion.contexto?.mediaId as string | null) ?? null;

  if (!rutaCifrada || m.tipo !== 'interactive_list' || !m.seleccionId?.startsWith('pedido:')) {
    await sendText(to, 'Por favor, elegí una de las cotizaciones de la lista de arriba. 👆\n\n_Escribí *menú* para volver al inicio._');
    return;
  }

  const pedidoId = m.seleccionId.replace('pedido:', '');
  const [pedido] = await query<PedidoCandidato>(
    `SELECT pe.id, pe.zona, pe.precio, td.moneda
       FROM pedidos pe
       LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
      WHERE pe.id = $1 AND pe.cliente_telefono = $2`,
    [pedidoId, to],
  );
  if (!pedido) {
    await clearSesion(to);
    await sendText(to, '🙁 Esa cotización ya no está disponible. Escribí *menú* para volver a empezar.');
    return;
  }

  try {
    await registrarComprobante(to, rutaCifrada, mediaId, pedido);
  } catch (err) {
    console.error('Error registrando comprobante tras elegir pedido:', err);
    await sendText(to, '⚠️ Tuvimos un problema al procesar el comprobante. Probá reenviarlo en unos minutos.');
  }
}

/**
 * Registra el pago (o lo agrega como adjunto si ya había uno pendiente para
 * el mismo pedido — sección 23, comprobante duplicado), alerta al panel y
 * sigue el flujo (a nombre de quién / factura). `pedido` puede venir
 * `undefined` si el cliente no tiene ninguna cotización abierta.
 */
async function registrarComprobante(
  to: string,
  rutaCifrada: string,
  mediaId: string | null,
  pedido: PedidoCandidato | undefined,
): Promise<void> {
  const pedidoId = pedido?.id ?? null;

  let pendienteId: string | null = null;
  let rechazadoId: string | null = null;

  if (pedidoId) {
    const [existente] = await query<{ id: string; estado: string }>(
      `SELECT id, estado FROM pagos WHERE pedido_id = $1 AND estado IN ('pendiente', 'rechazado') ORDER BY creado_en DESC LIMIT 1`,
      [pedidoId],
    );
    if (existente?.estado === 'pendiente') pendienteId = existente.id;
    else if (existente?.estado === 'rechazado') rechazadoId = existente.id;
  } else {
    const [existente] = await query<{ id: string; estado: string }>(
      `SELECT id, estado FROM pagos WHERE cliente_telefono = $1 AND estado IN ('pendiente', 'rechazado') ORDER BY creado_en DESC LIMIT 1`,
      [to],
    );
    if (existente?.estado === 'pendiente') pendienteId = existente.id;
    else if (existente?.estado === 'rechazado') rechazadoId = existente.id;
  }

  const esAdjunto = pendienteId !== null;
  const esReenviado = !esAdjunto && rechazadoId !== null;

  let pagoId: string;

  if (esAdjunto) {
    pagoId = pendienteId as string;
    await query(
      `INSERT INTO pagos_adjuntos (pago_id, url_comprobante, media_id) VALUES ($1,$2,$3)`,
      [pagoId, rutaCifrada, mediaId],
    );
    emitRecursoActualizado('pagos');
  } else if (esReenviado) {
    pagoId = rechazadoId as string;
    await query(
      `UPDATE pagos
          SET url_comprobante = $1,
              media_id = $2,
              estado = 'pendiente',
              motivo_rechazo = NULL,
              actualizado_en = now()
        WHERE id = $3`,
      [rutaCifrada, mediaId, pagoId],
    );
    emitRecursoActualizado('pagos');
  } else {
    const [pago] = await query<{ id: string }>(
      `INSERT INTO pagos (cliente_telefono, pedido_id, url_comprobante, media_id, estado)
       VALUES ($1,$2,$3,$4,'pendiente')
       RETURNING id`,
      [to, pedidoId, rutaCifrada, mediaId],
    );
    pagoId = pago.id;
  }

  // Alerta para el panel + push en tiempo real.
  let alerta: any;
  if (esReenviado) {
    await query(`UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'pago_pendiente_validacion' AND referencia_id = $1`, [pagoId]);
    const [nuevaAlerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje, estado)
       VALUES ('pago_pendiente_validacion', $1, $2, 'nueva')
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [pagoId, `Nuevo comprobante reenviado de ${to} pendiente de validar`],
    );
    alerta = nuevaAlerta;
  } else {
    const [nuevaAlerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('pago_pendiente_validacion', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [pagoId, `Nuevo comprobante de ${to} pendiente de validar`],
    );
    alerta = nuevaAlerta;
  }

  if (alerta) {
    emitAlerta({
      ...alerta,
      cliente_telefono: to,
      monto: null,
      pago_estado: 'pendiente',
      tiene_comprobante: true,
      zona: pedido?.zona ?? null,
      precio: pedido?.precio ?? null,
      moneda: pedido?.moneda ?? null,
    });
  }

  // Confirmar al cliente (sin prometer reserva automática)
  await sendText(
    to,
    esAdjunto
      ? '✅ ¡Recibido! Sumamos este comprobante a tu solicitud que ya estaba *pendiente de validación*.\n' +
        'En cuanto la confirmemos te mandamos el *ticket*. 📦\n\n' +
        '_Si en un rato no tenés novedades, escribí *asesor*._'
      : esReenviado
      ? '✅ ¡Recibido! Tu nuevo comprobante fue enviado y quedó *pendiente de validación* por un operador.\n' +
        'En cuanto lo confirmemos te mandamos el *ticket*. 📦\n\n' +
        '_Si en un rato no tenés novedades, escribí *asesor*._'
      : '✅ ¡Recibido! Tu comprobante quedó *pendiente de validación* por un operador.\n' +
        'En cuanto lo confirmemos te mandamos el *ticket*. 📦\n\n' +
        '_Si en un rato no tenés novedades, escribí *asesor*._',
  );

  if (esAdjunto || esReenviado) {
    await preguntarFactura(to, pagoId);
  } else {
    await setSesion({ telefono: to, flujo: 'pago', paso: 'esperando_titular', contexto: { pagoId } });
    await sendText(to, '🙋 ¿A nombre de quién es la transferencia?');
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
