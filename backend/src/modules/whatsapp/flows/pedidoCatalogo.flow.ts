import { query } from '../../../config/db';
import { sendText, sendButtons, downloadMedia } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { escalarAAsesor } from './asesor.flow';
import { opcionesMetodoPago } from './pago.flow';
import { obtenerOCrearCliente, necesitaNombre, ultimaDireccionCliente } from '../../../services/clientes.service';
import { adjuntarAUltimoMensaje } from '../chatLog.service';
import { encrypt, encryptBuffer } from '../../../services/crypto.service';
import { subirArchivo } from '../../../services/storage.service';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { manejarRespuestaInvalida } from '../estados';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Pedido armado en el catálogo de WhatsApp (carrito): Meta solo manda los
 * items y la cantidad, sin precio ni condiciones que el bot pueda resolver
 * solo. Antes esto escalaba directo al asesor con el detalle crudo del
 * carrito; ahora junta primero nombre, una descripción en palabras del
 * cliente (el retailer_id del catálogo todavía no tiene un nombre legible —
 * ver Content ID en Commerce Manager — así que esto es lo que hoy identifica
 * el producto para el asesor), dirección y medio de pago preferido — así el
 * asesor puede cotizar y cerrar sin tener que volver a preguntarle nada.
 * Orden pedido por el dueño: nombre -> descripción -> dirección -> medio de
 * pago -> asesor. Termina igual que antes, con escalarAAsesor.
 */
function detalleCarrito(m: MensajeEntrante): string {
  return (
    (m.orderItems ?? [])
      .map((it) => `${it.cantidad}x ${it.nombre ?? it.retailerId}${it.precio != null ? ` ($${it.precio})` : ''}`)
      .join(', ') || '(sin detalle)'
  );
}

export async function iniciarPedidoCatalogo(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const base: Sesion = { telefono: to, flujo: 'pedido_catalogo', paso: null, contexto: { detalleCarrito: detalleCarrito(m) } };

  if (await necesitaNombre(to)) {
    await sendText(to, '🙋 ¡Recibimos tu pedido del catálogo! Para que un asesor lo prepare, contame primero tu *nombre y apellido*.');
    await setSesion({ ...base, paso: 'nombre' });
    return;
  }
  await pedirDescripcion(to, base);
}

export async function handlePedidoCatalogo(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  if (sesion.paso === 'nombre') return manejarNombre(m, sesion);
  if (sesion.paso === 'descripcion') return manejarDescripcion(m, sesion);
  if (sesion.paso === 'direccion_eleccion') return manejarEleccionDireccion(m, sesion);
  if (sesion.paso === 'direccion') return manejarDireccion(m, sesion);
  if (sesion.paso === 'pago') return manejarPago(m, sesion);
  // El asesor ya cotizó por fuera del bot y disparó "Pedir transferencia"
  // desde el panel (ver POST /api/pagos/pedido-catalogo): ese endpoint le
  // mandó los datos bancarios al cliente y dejó la sesión acá, con el id del
  // pago 'pendiente' ya creado en contexto.pagoId.
  if (sesion.paso === 'esperando_comprobante_catalogo') return manejarComprobante(m, sesion);
}

async function manejarNombre(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const nombre = (m.texto ?? '').trim();
  if (m.tipo !== 'text' || nombre.length < 2) {
    await sendText(to, '🙋 Decime tu *nombre y apellido*, así el asesor te identifica.');
    return;
  }
  await obtenerOCrearCliente(to, nombre);
  await pedirDescripcion(to, sesion);
}

async function pedirDescripcion(to: string, sesion: Sesion): Promise<void> {
  await sendText(to, '📝 Contame un poco más de lo que necesitás (cantidad, tipo, etc.) para que el asesor lo tenga claro.');
  await setSesion({ ...sesion, paso: 'descripcion' });
}

async function manejarDescripcion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'text' || !m.texto || m.texto.trim().length < 2) {
    await sendText(to, '📝 Contame un poco más de lo que necesitás (cantidad, tipo, etc.).');
    return;
  }
  await pedirDireccion(to, { ...sesion, contexto: { ...sesion.contexto, descripcion: m.texto.trim() } });
}

/** Si ya hay una dirección de un pedido anterior, se ofrece como atajo en vez de pedirla de cero. */
async function pedirDireccion(to: string, sesion: Sesion): Promise<void> {
  const anterior = await ultimaDireccionCliente(to);
  if (anterior) {
    await sendButtons(
      to,
      `📍 ¿A dónde lo entregamos? Tenemos esta dirección de un pedido anterior:\n*${anterior}*`,
      [
        { id: 'direccion_misma', title: '✅ Esa misma' },
        { id: 'direccion_otra', title: '📍 Otra dirección' },
      ],
    );
    await setSesion({ ...sesion, paso: 'direccion_eleccion', contexto: { ...sesion.contexto, direccionAnterior: anterior } });
    return;
  }
  await sendText(to, '📍 ¿A qué dirección lo entregamos? (calle, número y localidad)');
  await setSesion({ ...sesion, paso: 'direccion' });
}

async function manejarEleccionDireccion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'direccion_misma') {
    const direccion = sesion.contexto.direccionAnterior as string;
    await pedirMedioPago(to, { ...sesion, contexto: { ...sesion.contexto, direccion } });
    return;
  }
  if (m.seleccionId === 'direccion_otra') {
    await sendText(to, '📍 Decime la dirección completa (calle, número y localidad).');
    await setSesion({ ...sesion, paso: 'direccion' });
    return;
  }
  await manejarRespuestaInvalida(m, 'Elegí "✅ Esa misma" o "📍 Otra dirección".');
}

async function manejarDireccion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'text' || !m.texto || m.texto.trim().length < 4) {
    await sendText(to, '📍 Decime la dirección completa (calle, número y localidad).');
    return;
  }
  await pedirMedioPago(to, { ...sesion, contexto: { ...sesion.contexto, direccion: m.texto.trim() } });
}

async function pedirMedioPago(to: string, sesion: Sesion): Promise<void> {
  await sendButtons(to, '💳 ¿Cómo preferís pagar?', await opcionesMetodoPago(to));
  await setSesion({ ...sesion, paso: 'pago' });
}

const ETIQUETAS_MEDIO_PAGO: Record<string, string> = {
  metodo_transferencia: '💸 Transferencia',
  metodo_efectivo: '💵 Efectivo',
  metodo_cuenta_corriente: '📋 Cuenta corriente',
};

async function manejarPago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const medioPago = m.seleccionId ? ETIQUETAS_MEDIO_PAGO[m.seleccionId] : undefined;
  if (!medioPago) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una de las opciones que te mostramos arriba. 👆');
    return;
  }

  const { detalleCarrito, direccion, descripcion } = sesion.contexto as {
    detalleCarrito: string;
    direccion: string;
    descripcion: string;
  };
  const [cliente] = await query<{ nombre: string }>('SELECT nombre FROM clientes WHERE telefono = $1', [to]);
  const resumen =
    `🧾 *Resumen de tu pedido*\n` +
    `Cliente: ${cliente?.nombre ?? 'Sin nombre'}\n` +
    `Pedido: ${detalleCarrito}\n` +
    `Detalle: ${descripcion}\n` +
    `Dirección: ${direccion}\n` +
    `Medio de pago: ${medioPago}`;

  // Se manda como mensaje normal (sendText ya lo deja logueado en
  // mensajes_chat) para que quede visible en el hilo de Conversaciones
  // cuando el asesor abra la charla — el motivo de la alerta solo no
  // alcanzaba, el operador trabaja desde el chat, no desde Alertas.
  await sendText(to, resumen);
  await escalarAAsesor(to, sesion, `${to} envió un pedido desde el catálogo — resumen completo en la conversación`);
}

/**
 * El cliente manda la foto/PDF de la transferencia que el asesor le pidió
 * desde el panel (POST /api/pagos/pedido-catalogo ya creó el pago
 * 'pendiente' y guardó su id en contexto.pagoId). A diferencia del flujo de
 * contenedores (pago.flow.ts), acá no hay que adivinar a qué pedido
 * corresponde: ya viene resuelto en la sesión, así que se actualiza directo
 * ese pago en vez de pasar por pedidosAbiertos().
 */
async function manejarComprobante(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const pagoId = sesion.contexto?.pagoId as string | undefined;
  if (!pagoId) {
    // Sesión vencida o corrupta (sin el id del pago) — no hay a qué atar el
    // comprobante. Se corta el flujo y se le avisa al cliente en vez de
    // procesar una foto que después nadie va a poder revisar.
    await clearSesion(to);
    await sendText(to, '🙁 Pasó demasiado tiempo desde que te pedimos la transferencia. Escribí *asesor* para que te pasemos los datos de nuevo.');
    return;
  }
  if (m.tipo !== 'image' && m.tipo !== 'document') {
    await sendText(to, '📎 Necesito la foto o el PDF del comprobante de la transferencia.');
    return;
  }

  try {
    const { buffer, mime } = await downloadMedia(m.mediaId!);
    const ext = mime.includes('pdf') ? 'pdf' : mime.split('/')[1] || 'jpg';
    const filename = `${to}_${Date.now()}.${ext}`;
    const rutaStorage = `comprobantes/${filename}`;
    await subirArchivo(encryptBuffer(buffer), rutaStorage, 'application/octet-stream');
    const rutaCifrada = encrypt(rutaStorage);
    await adjuntarAUltimoMensaje(to, rutaCifrada);

    const [pago] = await query<{ id: string }>(
      `UPDATE pagos SET url_comprobante = $2, media_id = $3
        WHERE id = $1 AND estado = 'pendiente'
        RETURNING id`,
      [pagoId, rutaCifrada, m.mediaId ?? null],
    );
    if (!pago) {
      await clearSesion(to);
      await sendText(to, '🙁 Ese pedido de transferencia ya no está disponible. Escribí *asesor* si todavía necesitás pagar.');
      return;
    }

    const [alerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('pago_pendiente_validacion', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [pagoId, `${to} envió el comprobante de su pedido del catálogo`],
    );
    if (alerta) emitAlerta({ ...alerta, cliente_telefono: to, monto: null, pago_estado: 'pendiente', tiene_comprobante: true, zona: null, precio: null });
    emitRecursoActualizado('pagos');

    // Sin mencionar "ticket" a propósito: eso es el comprobante de entrega de
    // contenedores (enviarTicketPorWhatsApp), que no tiene sentido acá — este
    // pedido no tiene contenedor ni zona asociados.
    await clearSesion(to);
    await sendText(
      to,
      '✅ ¡Recibido! Tu comprobante quedó *pendiente de validación* por un operador.\n\n' +
        '_Si en un rato no tenés novedades, escribí *asesor*._',
    );
  } catch (err) {
    console.error('Error registrando comprobante de pedido de catálogo:', err);
    await sendText(to, '⚠️ Tuvimos un problema al procesar el comprobante. Probá reenviarlo en unos minutos.');
  }
}
