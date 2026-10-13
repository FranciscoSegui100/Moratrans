import { query } from '../../../config/db';
import { sendText, sendButtons } from '../graphApi';
import { setSesion } from '../session.store';
import { escalarAAsesor } from './asesor.flow';
import { opcionesMetodoPago } from './pago.flow';
import { obtenerOCrearCliente, necesitaNombre, ultimaDireccionCliente } from '../../../services/clientes.service';
import { manejarRespuestaInvalida } from '../estados';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Pedido armado en el catálogo de WhatsApp (carrito): Meta solo manda los
 * items y la cantidad, sin precio ni condiciones que el bot pueda resolver
 * solo. Antes esto escalaba directo al asesor con el detalle crudo del
 * carrito; ahora junta primero nombre, una descripción en palabras del
 * cliente (útil mientras el retailer_id del catálogo siga sin un nombre
 * legible, ver graphApi.ts::obtenerNombresProductos), dirección y medio de
 * pago preferido — así el asesor puede cotizar y cerrar sin tener que volver
 * a preguntarle nada. Orden pedido por el dueño: nombre -> descripción ->
 * dirección -> medio de pago -> asesor. Termina igual que antes, con
 * escalarAAsesor.
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

  await escalarAAsesor(
    to,
    sesion,
    `🧾 Resumen del pedido del catálogo (${to})\n` +
      `Cliente: ${cliente?.nombre ?? 'Sin nombre'}\n` +
      `Pedido: ${detalleCarrito}\n` +
      `Detalle del cliente: ${descripcion}\n` +
      `Dirección: ${direccion}\n` +
      `Medio de pago preferido: ${medioPago}`,
  );
}
