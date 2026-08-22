import { query } from '../../../config/db';
import { sendText, sendButtons, sendList, sendLocationRequest } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { contenedoresDelCliente, ContenedorCliente } from '../../../services/contenedorCliente.service';
import { datosBancarios } from './pago.flow';
import { reverseGeocode } from '../../../services/geocoding.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Recambio: el chofer deja un contenedor vacío y se lleva el lleno en la
 * misma visita, sin que el cliente tenga que esperar un viaje aparte para
 * cada cosa. Se cobra igual que una entrega nueva (tarifa de la zona) — al
 * confirmar acá solo se registra un `pedido` (tipo='recambio', con el
 * contenedor lleno ya conocido) y se lo manda al mismo circuito de pago que
 * cualquier cotización; los dos viajes ('retiro' del lleno + 'entrega' del
 * vacío, unidos por grupo_id) recién se crean cuando un operador valida el
 * pago (ver pagos.routes.ts /validar).
 *
 * Pasos: (elegir_contenedor_recambio) -> confirmar_recambio ->
 * confirmar_ubicacion_recambio [-> ubicacion_recambio, si la corrige] -> pago.
 */
export async function handleRecambio(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'elegir_contenedor_recambio') {
    return manejarEleccionContenedor(m);
  }
  if (sesion.paso === 'confirmar_recambio') {
    return manejarConfirmacionContenedor(m, sesion);
  }
  if (sesion.paso === 'confirmar_ubicacion_recambio') {
    return manejarConfirmacionUbicacion(m, sesion);
  }
  if (sesion.paso === 'ubicacion_recambio') {
    return manejarNuevaUbicacion(m, sesion);
  }

  const conts = await contenedoresDelCliente(to);
  if (conts.length === 0) {
    await clearSesion(to);
    await sendText(
      to,
      '🙁 No encontramos ningún contenedor entregado a tu nombre en este momento. Escribí *asesor* si creés que es un error.',
    );
    return;
  }
  if (conts.length === 1) {
    return pedirConfirmacionContenedor(to, conts[0]);
  }
  await setSesion({ telefono: to, flujo: 'recambio', paso: 'elegir_contenedor_recambio', contexto: {} });
  await sendList(
    to,
    '🔄 Recambio',
    'Tenés más de un contenedor con nosotros — ¿cuál querés recambiar?',
    'Ver contenedores',
    conts.map((c) => ({ id: `rec:${c.numero}`, title: c.numero })),
  );
}

async function manejarEleccionContenedor(m: MensajeEntrante): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'interactive_list' || !m.seleccionId?.startsWith('rec:')) {
    await sendText(to, 'Por favor, elegí uno de la lista de arriba. 👆\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  const numero = m.seleccionId.replace('rec:', '');
  const cont = (await contenedoresDelCliente(to)).find((c) => c.numero === numero);
  if (!cont) {
    await clearSesion(to);
    await sendText(to, '🙁 Ese contenedor ya no está disponible para recambio. Escribí *menú* para volver a empezar.');
    return;
  }
  await pedirConfirmacionContenedor(to, cont);
}

async function pedirConfirmacionContenedor(to: string, cont: ContenedorCliente): Promise<void> {
  await setSesion({
    telefono: to,
    flujo: 'recambio',
    paso: 'confirmar_recambio',
    contexto: {
      numero: cont.numero,
      zona: cont.zona,
      destinoDireccion: cont.destino_direccion,
      destinoLat: cont.destino_lat,
      destinoLng: cont.destino_lng,
    },
  });
  await sendButtons(
    to,
    `🔄 ¿Confirmás el recambio del contenedor *${cont.numero}*?\nVamos a coordinar que un chofer te deje uno vacío y se lleve el lleno.`,
    [
      { id: 'recambio_si', title: '✅ Sí, confirmar' },
      { id: 'recambio_no', title: '↩️ Cancelar' },
    ],
  );
}

async function manejarConfirmacionContenedor(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'recambio_no') {
    await clearSesion(to);
    await sendText(to, '👍 Listo, no pedimos el recambio. Escribí *menú* si necesitás algo más.');
    return;
  }
  if (m.seleccionId !== 'recambio_si') {
    await sendText(to, 'Elegí "✅ Sí, confirmar" o "↩️ Cancelar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  await pedirConfirmacionUbicacion(to, sesion);
}

/**
 * Antes de cobrar, mostramos la dirección que ya tenemos registrada (de la
 * entrega activa de ese contenedor) y pedimos que la confirme — para no
 * errarle si el cliente se mudó o el chofer terminó dejándolo en otro lado.
 * Si no hay ninguna guardada, se pide directamente.
 */
async function pedirConfirmacionUbicacion(to: string, sesion: Sesion): Promise<void> {
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;
  if (!destino) {
    await setSesion({ ...sesion, paso: 'ubicacion_recambio' });
    await sendLocationRequest(
      to,
      '📍 No tenemos una dirección cargada para este contenedor: tocá "Enviar ubicación" o escribila en un mensaje.',
    );
    return;
  }
  await setSesion({ ...sesion, paso: 'confirmar_ubicacion_recambio' });
  await sendButtons(
    to,
    `📍 Vamos a coordinar el recambio en esta dirección:\n\n${destino}\n\n¿Sigue siendo correcta?`,
    [
      { id: 'ubicacion_recambio_si', title: '✅ Sí, es correcta' },
      { id: 'ubicacion_recambio_no', title: '↩️ Corregirla' },
    ],
  );
}

async function manejarConfirmacionUbicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'ubicacion_recambio_no') {
    await setSesion({ ...sesion, paso: 'ubicacion_recambio' });
    await sendLocationRequest(to, '📍 Dale, mandámela de nuevo: tocá "Enviar ubicación" o escribí la dirección.');
    return;
  }
  if (m.seleccionId !== 'ubicacion_recambio_si') {
    await sendText(to, 'Elegí "✅ Sí, es correcta" o "↩️ Corregirla".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  await confirmarYPedirPago(m, sesion);
}

async function manejarNuevaUbicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  let destinoDireccion: string | null = null;
  let destinoLat: number | null = null;
  let destinoLng: number | null = null;

  if (m.tipo === 'location') {
    destinoLat = m.lat ?? null;
    destinoLng = m.lng ?? null;
    destinoDireccion = m.ubicacionDireccion || m.ubicacionNombre || null;
    if (!destinoDireccion && destinoLat != null && destinoLng != null) {
      destinoDireccion = await reverseGeocode(destinoLat, destinoLng);
    }
  } else if (m.tipo === 'text' && m.texto && m.texto.trim().length >= 5) {
    destinoDireccion = m.texto.trim();
  } else {
    await sendText(
      to,
      '📍 Necesito la dirección: tocá el botón de "Enviar ubicación" o escribila en un mensaje (ej: _Av. San Martín 1234, Barrio Centro_).',
    );
    return;
  }

  const nuevaSesion: Sesion = { ...sesion, contexto: { ...sesion.contexto, destinoDireccion, destinoLat, destinoLng } };
  await setSesion(nuevaSesion);
  await pedirConfirmacionUbicacion(to, nuevaSesion);
}

async function confirmarYPedirPago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const numero = sesion.contexto.numero as string;
  const zona = (sesion.contexto.zona as string | null) ?? null;
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;
  const destinoLat = (sesion.contexto.destinoLat as number | null) ?? null;
  const destinoLng = (sesion.contexto.destinoLng as number | null) ?? null;

  if (!zona) {
    await clearSesion(to);
    await sendText(to, '🙁 No tenemos la zona cargada para ese contenedor. Escribí *asesor* para coordinar el recambio.');
    return;
  }

  const tarifa = await query<{ precio: string; moneda: string }>(
    'SELECT precio, moneda FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [zona],
  );
  if (tarifa.length === 0) {
    await clearSesion(to);
    await sendText(to, '🙁 No encontramos la tarifa para tu zona. Escribí *asesor* para coordinar el recambio.');
    return;
  }
  const { precio, moneda } = tarifa[0];

  await query(
    `INSERT INTO pedidos (cliente_telefono, cliente_nombre, zona, precio, estado, destino_direccion, destino_lat, destino_lng, tipo, contenedor_recambio_numero)
     VALUES ($1,$2,$3,$4,'confirmado',$5,$6,$7,'recambio',$8)`,
    [to, m.nombrePerfil ?? null, zona, precio, destino, destinoLat, destinoLng, numero],
  );

  await clearSesion(to);
  await sendText(
    to,
    `🔄 *Recambio — contenedor ${numero}*\n` +
      `Precio del flete: *${moneda} ${Number(precio).toLocaleString('es-AR')}*\n` +
      (destino ? `Dirección: ${destino}\n\n` : '\n') +
      `Para coordinar el recambio, hacé el pago con estos datos:\n\n` +
      `${datosBancarios()}\n\n` +
      `Y enviános el comprobante por este chat 📎\n` +
      `(escribí *Ya pagué* o adjuntá directamente la foto/PDF).\n\n` +
      `_Escribí *menú* para volver al inicio en cualquier momento._`,
  );
}
