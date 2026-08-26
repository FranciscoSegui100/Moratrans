import { randomUUID } from 'crypto';
import { query } from '../../../config/db';
import { sendText, sendButtons, sendList, sendLocationRequest } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { contenedoresDelCliente, ContenedorCliente } from '../../../services/contenedorCliente.service';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import { obtenerOCrearCliente, necesitaNombre } from '../../../services/clientes.service';
import { datosBancarios, tieneCuentaCorrienteAprobada, pedidosAbiertos, mensajePedidoPendiente } from './pago.flow';
import { reverseGeocode } from '../../../services/geocoding.service';
import { OPCIONES_HORARIO, pedirHorarioPreferido } from './horarioPreferido.flow';
import { manejarRespuestaInvalida } from '../estados';
import {
  pedirDepartamento,
  departamentoElegido,
  pedirMetodoUbicacion,
  mensajePedirCalleNumero,
  verificarUbicacionConDepartamentoElegido,
  preguntarMismatchDepartamento,
  resolverUbicacionMensaje,
  mensajePedirUbicacionPasoAPaso,
  combinarDireccionConIndicacion,
  normalizarIndicacion,
} from './ubicacionZona.helper';
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
 * Ubicación: si la dirección ya registrada del contenedor sigue sirviendo,
 * se confirma con un sí/no simple (ya fue verificada en su momento). Si es
 * una dirección NUEVA, se elige departamento primero y después pin
 * (prioritario, verificado por geometría real contra el departamento
 * elegido — si no coincide, el cliente decide, ver
 * ubicacionZona.helper.ts) o calle/número a mano sin buscar en el mapa
 * (marcados `direccion_verificada = false` — el propio cliente la confirma,
 * resaltada en negrita, en la capa 4) — mismo criterio que
 * cotizacion.flow.ts. La zona se recalcula siempre a partir de la dirección
 * nueva, nunca se asume la del contenedor viejo.
 *
 * Pasos: (elegir_contenedor_recambio) -> confirmar_recambio ->
 * confirmar_ubicacion_recambio [-> elegir_departamento_recambio ->
 * elegir_metodo_ubicacion_recambio -> [ubicacion_pin_recambio [->
 * confirmar_departamento_pin_recambio] | ubicacion_texto_recambio] ->
 * confirmar_ubicacion_recambio_nueva (capa 4) -> indicacion_recambio] ->
 * horario_recambio -> [confirmar_resumen_recambio -> [pedir_nombre_recambio,
 * si es la primera vez que este teléfono confirma un pedido], si no es
 * cuenta corriente] -> pago.
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
  if (sesion.paso === 'elegir_departamento_recambio') {
    return manejarDepartamento(m, sesion);
  }
  if (sesion.paso === 'elegir_metodo_ubicacion_recambio') {
    return manejarMetodoUbicacion(m, sesion);
  }
  if (sesion.paso === 'ubicacion_pin_recambio') {
    return manejarNuevaUbicacion(m, sesion);
  }
  if (sesion.paso === 'confirmar_departamento_pin_recambio') {
    return manejarMismatchDepartamento(m, sesion);
  }
  if (sesion.paso === 'ubicacion_texto_recambio') {
    return manejarUbicacionTexto(m, sesion);
  }
  if (sesion.paso === 'confirmar_ubicacion_recambio_nueva') {
    return manejarConfirmacionUbicacionNueva(m, sesion);
  }
  if (sesion.paso === 'indicacion_recambio') {
    return manejarIndicacion(m, sesion);
  }
  if (sesion.paso === 'horario_recambio') {
    return manejarHorario(m, sesion);
  }
  if (sesion.paso === 'confirmar_resumen_recambio') {
    return manejarConfirmacionResumenRecambio(m, sesion);
  }
  if (sesion.paso === 'pedir_nombre_recambio') {
    return manejarNombreRecambio(m, sesion);
  }

  // Igual que Cotizar: si no es cuenta corriente (ahí no hay comprobante que
  // esperar) y ya tiene un pedido sin pagar, se le pide que pague ese
  // primero antes de arrancar un recambio nuevo.
  if (!(await tieneCuentaCorrienteAprobada(to))) {
    const [pendiente] = await pedidosAbiertos(to);
    if (pendiente) {
      await clearSesion(to);
      await sendText(to, mensajePedidoPendiente(pendiente));
      return;
    }
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
    await manejarRespuestaInvalida(m, 'Por favor, elegí uno de la lista de arriba. 👆\n\n_Escribí *menú* para volver al inicio._');
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
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, confirmar" o "↩️ Cancelar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  await pedirConfirmacionUbicacion(to, sesion);
}

/**
 * Antes de cobrar, mostramos la dirección que ya tenemos registrada (de la
 * entrega activa de ese contenedor) y pedimos que la confirme — para no
 * errarle si el cliente se mudó o el chofer terminó dejándolo en otro lado.
 * Si confirma que sigue siendo la misma, no hace falta re-verificarla (ya
 * pasó por las 4 capas cuando se cargó esa entrega). Si no hay ninguna
 * guardada, o la corrige, pasa a pedir una dirección nueva.
 */
async function pedirConfirmacionUbicacion(to: string, sesion: Sesion): Promise<void> {
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;
  if (!destino) {
    await pedirUbicacionNueva(to, sesion);
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
    await pedirUbicacionNueva(to, sesion);
    return;
  }
  if (m.seleccionId !== 'ubicacion_recambio_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, es correcta" o "↩️ Corregirla".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  await pedirHorarioPreferido(to, '🕐 ¿En qué franja horaria preferís que coordinemos el recambio?');
  await setSesion({ ...sesion, paso: 'horario_recambio' });
}

async function pedirUbicacionNueva(to: string, sesion: Sesion): Promise<void> {
  if (!(await pedirDepartamento(to, '📍 ¿A qué *departamento* es la dirección nueva?'))) {
    await clearSesion(to);
    return;
  }
  await setSesion({ ...sesion, paso: 'elegir_departamento_recambio' });
}

async function manejarDepartamento(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = departamentoElegido(m);
  if (!departamento) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una opción de la lista.\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  await setSesion({ ...sesion, paso: 'elegir_metodo_ubicacion_recambio', contexto: { ...sesion.contexto, departamento } });
  await pedirMetodoUbicacion(to, departamento);
}

async function manejarMetodoUbicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = sesion.contexto.departamento as string;

  if (m.seleccionId === 'metodo_pin') {
    await setSesion({ ...sesion, paso: 'ubicacion_pin_recambio' });
    await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Mandanos el pin de la dirección nueva en *${departamento}*.`));
    return;
  }
  if (m.seleccionId === 'metodo_texto') {
    await setSesion({ ...sesion, paso: 'ubicacion_texto_recambio' });
    await sendText(to, mensajePedirCalleNumero(departamento));
    return;
  }
  await manejarRespuestaInvalida(m, 'Elegí una de las opciones de abajo. 👇');
}

async function manejarHorario(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const opcion = OPCIONES_HORARIO.find((o) => o.id === m.seleccionId);
  if (!opcion) {
    await pedirHorarioPreferido(m.from, 'Elegí una de las opciones de abajo. 👇');
    return;
  }
  await confirmarYPedirPago(m, { ...sesion, contexto: { ...sesion.contexto, horarioPreferido: opcion.title } });
}

/** Dirección nueva del recambio, pin: se verifica contra el departamento ya elegido por geometría real (ver verificarUbicacionConDepartamentoElegido). */
async function manejarNuevaUbicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = sesion.contexto.departamento as string;
  const ubicacion = await resolverUbicacionMensaje(m);

  if (ubicacion.tipo === 'ubicacion') {
    const destinoDireccion = ubicacion.direccionCruda ?? (await reverseGeocode(ubicacion.lat, ubicacion.lng));

    const numero = sesion.contexto.numero as string;
    const resultado = await verificarUbicacionConDepartamentoElegido(m, sesion, ubicacion.lat, ubicacion.lng, destinoDireccion, departamento, {
      requiereTarifa: true,
      contextoPedidoFueraDeZona: { tipo: 'recambio', contenedorRecambioNumero: numero },
    });
    if (!resultado.ok) return;

    if (!resultado.coincide) {
      await preguntarMismatchDepartamento(to, resultado.departamentoElegido, resultado.departamentoDetectado);
      await setSesion({
        ...sesion,
        paso: 'confirmar_departamento_pin_recambio',
        contexto: { ...sesion.contexto, departamento, departamentoDetectado: resultado.departamentoDetectado, destinoLat: ubicacion.lat, destinoLng: ubicacion.lng, destinoDireccion },
      });
      return;
    }

    // La zona se recalcula con la ubicación nueva — no se asume la del
    // contenedor viejo, podría ser una dirección en otro departamento con otra tarifa.
    await avanzarACapaCuatroRecambio(to, sesion, resultado.departamento, ubicacion.lat, ubicacion.lng, destinoDireccion, true);
    return;
  }

  if (ubicacion.tipo === 'link_invalido') {
    await sendText(to, '🙁 No pude leer ese link de Maps. Probá copiarlo de nuevo desde el botón "Compartir", o usá el botón "Enviar ubicación" de abajo.');
    return;
  }

  await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Mandanos el pin de la dirección nueva en *${departamento}*.`));
}

async function manejarMismatchDepartamento(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const { departamento, departamentoDetectado, destinoLat, destinoLng, destinoDireccion } = sesion.contexto as {
    departamento: string;
    departamentoDetectado: string;
    destinoLat: number;
    destinoLng: number;
    destinoDireccion: string | null;
  };

  if (m.seleccionId === 'depto_reenviar') {
    await setSesion({ ...sesion, paso: 'ubicacion_pin_recambio', contexto: { ...sesion.contexto, departamento } });
    await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Dale, mandanos de nuevo el pin de la dirección en *${departamento}*.`));
    return;
  }
  if (m.seleccionId !== 'depto_cambiar') {
    await manejarRespuestaInvalida(m, 'Elegí una de las opciones de abajo. 👇');
    return;
  }

  const [tarifa] = await query<{ precio: string; moneda: string }>(
    'SELECT precio, moneda FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [departamentoDetectado],
  );
  if (!tarifa) {
    await sendText(to, `🙁 No tenemos tarifa activa en *${departamentoDetectado}* todavía. Escribí *asesor* para coordinarlo.`);
    await clearSesion(to);
    return;
  }
  await avanzarACapaCuatroRecambio(to, sesion, departamentoDetectado, destinoLat, destinoLng, destinoDireccion, true);
}

/** Dirección nueva del recambio, escrita a mano: se guarda tal cual, sin buscarla en el mapa. */
async function manejarUbicacionTexto(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = sesion.contexto.departamento as string;

  if (m.tipo !== 'text' || !m.texto || m.texto.trim().length < 4) {
    await sendText(to, mensajePedirCalleNumero(departamento));
    return;
  }

  const [tarifa] = await query<{ precio: string; moneda: string }>(
    'SELECT precio, moneda FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [departamento],
  );
  if (!tarifa) {
    await sendText(to, `🙁 No tenemos tarifa activa en *${departamento}* todavía. Escribí *asesor* para coordinarlo.`);
    await clearSesion(to);
    return;
  }
  await avanzarACapaCuatroRecambio(to, sesion, departamento, null, null, m.texto.trim(), false);
}

/** Capa 4 para dirección nueva: misma pregunta puntual que "Cotizar", ver cotizacion.flow.ts. */
async function avanzarACapaCuatroRecambio(
  to: string,
  sesion: Sesion,
  departamento: string,
  destinoLat: number | null,
  destinoLng: number | null,
  destinoDireccion: string | null,
  direccionVerificada: boolean,
): Promise<void> {
  const resumenUbicacion =
    destinoLat != null && destinoLng != null
      ? `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`
      : `*${destinoDireccion}*`;

  await sendButtons(
    to,
    `📍 Dirección: ${resumenUbicacion}\nZona: *${departamento}*\n\n` +
      `¿Confirmás que esta es la dirección exacta donde debe entregarse el contenedor?`,
    [
      { id: 'ubicacion_es_destino', title: '✅ Sí, es correcta' },
      { id: 'ubicacion_no', title: '↩️ Mandar otra' },
    ],
  );
  await setSesion({
    ...sesion,
    paso: 'confirmar_ubicacion_recambio_nueva',
    contexto: { ...sesion.contexto, zona: departamento, departamento, destinoLat, destinoLng, destinoDireccion, direccionVerificada },
  });
}

async function manejarConfirmacionUbicacionNueva(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (m.seleccionId === 'ubicacion_no') {
    const departamento = sesion.contexto.departamento as string;
    await setSesion({ ...sesion, paso: 'elegir_metodo_ubicacion_recambio', contexto: { ...sesion.contexto, departamento } });
    await pedirMetodoUbicacion(to, departamento);
    return;
  }
  if (m.seleccionId !== 'ubicacion_es_destino') {
    await manejarRespuestaInvalida(
      m,
      'Elegí "✅ Sí, es correcta" o "↩️ Mandar otra".\n\n_Escribí *menú* para volver al inicio._',
    );
    return;
  }

  await sendText(to, '🚚 ¿Alguna indicación para el chofer (portón, timbre, entre calles)? Si no hay, escribí "no".');
  await setSesion({ ...sesion, paso: 'indicacion_recambio' });
}

async function manejarIndicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'text' || !m.texto) {
    await sendText(to, '🚚 Contame si hay alguna indicación para el chofer, o escribí "no".');
    return;
  }
  const indicacion = normalizarIndicacion(m.texto);
  const destinoDireccion = combinarDireccionConIndicacion(sesion.contexto.destinoDireccion as string | null, indicacion);
  await pedirHorarioPreferido(to, '🕐 ¿En qué franja horaria preferís que coordinemos el recambio?');
  await setSesion({ ...sesion, paso: 'horario_recambio', contexto: { ...sesion.contexto, destinoDireccion } });
}

async function confirmarYPedirPago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const zona = (sesion.contexto.zona as string | null) ?? null;

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

  // Cuenta corriente aprobada: se confirma solo, sin pedir comprobante — se
  // suma directo a la deuda (ver reportes.service.ts::itemsCuentaCorriente).
  if (await tieneCuentaCorrienteAprobada(to)) {
    return registrarRecambioCC(m, sesion, precio, moneda);
  }

  await mostrarResumenYConfirmarRecambio(to, sesion, precio, moneda);
}

/** Resumen completo antes de pagar (mismo criterio que cotizacion.flow.ts): recién si confirma se crea el pedido y se le pasan los datos para transferir. */
async function mostrarResumenYConfirmarRecambio(to: string, sesion: Sesion, precio: string, moneda: string): Promise<void> {
  const numero = sesion.contexto.numero as string;
  const zona = sesion.contexto.zona as string;
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;
  const destinoLat = (sesion.contexto.destinoLat as number | null) ?? null;
  const destinoLng = (sesion.contexto.destinoLng as number | null) ?? null;
  const horarioPreferido = (sesion.contexto.horarioPreferido as string | null) ?? null;
  const resumenDireccion = destino != null && destinoLat == null && destinoLng == null ? `*${destino}*` : destino;

  await sendButtons(
    to,
    `🔄 *Resumen del recambio*\n\n` +
      `Contenedor: *${numero}*\n` +
      (resumenDireccion ? `Dirección: ${resumenDireccion}\n` : '') +
      `Zona: *${zona}*\n` +
      `Precio del flete: *${moneda} ${Number(precio).toLocaleString('es-AR')}*\n` +
      (horarioPreferido ? `Franja horaria: ${horarioPreferido}\n` : '') +
      `\n¿Confirmás el recambio?`,
    [
      { id: 'resumen_recambio_si', title: '✅ Sí, confirmar' },
      { id: 'resumen_recambio_no', title: '↩️ Cancelar' },
    ],
  );
  await setSesion({ ...sesion, paso: 'confirmar_resumen_recambio', contexto: { ...sesion.contexto, precio, moneda } });
}

async function manejarConfirmacionResumenRecambio(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'resumen_recambio_no') {
    await clearSesion(to);
    await sendText(to, '👍 Sin problema, no quedó nada guardado. Escribí *menú* para ver otras opciones.');
    return;
  }
  if (m.seleccionId !== 'resumen_recambio_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, confirmar" o "↩️ Cancelar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }

  if (await necesitaNombre(to)) {
    await sendText(to, MENSAJE_PEDIR_NOMBRE);
    await setSesion({ ...sesion, paso: 'pedir_nombre_recambio' });
    return;
  }
  await finalizarRecambioPago(m, sesion);
}

const MENSAJE_PEDIR_NOMBRE = '🙋 Antes de confirmar, decime tu *nombre y apellido* para tenerlo registrado.';

async function manejarNombreRecambio(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const nombre = (m.texto ?? '').trim();
  if (m.tipo !== 'text' || nombre.length < 2) {
    await sendText(to, MENSAJE_PEDIR_NOMBRE);
    return;
  }
  await obtenerOCrearCliente(to, nombre);
  await finalizarRecambioPago(m, sesion);
}

async function finalizarRecambioPago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const numero = sesion.contexto.numero as string;
  const zona = sesion.contexto.zona as string;
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;
  const destinoLat = (sesion.contexto.destinoLat as number | null) ?? null;
  const destinoLng = (sesion.contexto.destinoLng as number | null) ?? null;
  const direccionVerificada = (sesion.contexto.direccionVerificada as boolean | undefined) ?? true;
  const horarioPreferido = (sesion.contexto.horarioPreferido as string | null) ?? null;
  const precio = sesion.contexto.precio as string;
  const moneda = sesion.contexto.moneda as string;

  await query(
    `INSERT INTO pedidos (cliente_telefono, cliente_nombre, zona, precio, estado, destino_direccion, destino_lat, destino_lng, direccion_verificada, horario_preferido, tipo, contenedor_recambio_numero)
     VALUES ($1,$2,$3,$4,'confirmado',$5,$6,$7,$8,$9,'recambio',$10)`,
    [to, m.nombrePerfil ?? null, zona, precio, destino, destinoLat, destinoLng, direccionVerificada, horarioPreferido, numero],
  );

  await clearSesion(to);
  await sendText(
    to,
    `✅ *Recambio confirmado — contenedor ${numero}*\n\n` +
      `Para reservarlo, hacé el pago con estos datos:\n\n` +
      `${datosBancarios()}\n\n` +
      `Y enviános el comprobante por este chat 📎\n` +
      `(escribí *Ya pagué* o adjuntá directamente la foto/PDF).\n\n` +
      `_Escribí *menú* para volver al inicio en cualquier momento._`,
  );
}

/**
 * Recambio para un cliente con cuenta corriente aprobada: nada de comprobante
 * ni validación de un operador — se crean directo los dos viajes (retiro del
 * lleno + entrega del vacío, unidos por grupo_id, mismo patrón que
 * pagos.routes.ts al validar un recambio pagado) y el costo se suma a la
 * deuda de cuenta corriente (viajes.es_cuenta_corriente, ver
 * reportes.service.ts). Sin chofer asignado todavía — se arma después desde
 * la pestaña Rutas, como cualquier viaje nuevo.
 */
async function registrarRecambioCC(m: MensajeEntrante, sesion: Sesion, precio: string, moneda: string): Promise<void> {
  const to = m.from;
  const numero = sesion.contexto.numero as string;
  const zona = sesion.contexto.zona as string;
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;
  const destinoLat = (sesion.contexto.destinoLat as number | null) ?? null;
  const destinoLng = (sesion.contexto.destinoLng as number | null) ?? null;
  const direccionVerificada = (sesion.contexto.direccionVerificada as boolean | undefined) ?? true;
  const horarioPreferido = (sesion.contexto.horarioPreferido as string | null) ?? null;

  const grupoId = randomUUID();
  const vaciadero = await resolverUbicacion('vaciadero');
  const deposito = await resolverUbicacion('deposito');

  await query(
    `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, direccion_verificada, horario_preferido, estado, notas, grupo_id, ubicacion_id, ubicacion_direccion)
     VALUES ('retiro', CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, 'programado', 'Recambio pedido por WhatsApp (cuenta corriente)', $9, $10, $11)`,
    [numero, to, zona, destino, destinoLat, destinoLng, direccionVerificada, horarioPreferido, grupoId, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
  );
  await query(
    `INSERT INTO viajes (tipo, fecha, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, direccion_verificada, horario_preferido, importe, es_cuenta_corriente, estado, notas, grupo_id, ubicacion_id, ubicacion_direccion)
     VALUES ('entrega', CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, TRUE, 'programado', 'Recambio pedido por WhatsApp (cuenta corriente)', $9, $10, $11)`,
    [to, zona, destino, destinoLat, destinoLng, direccionVerificada, horarioPreferido, precio, grupoId, deposito?.id ?? null, deposito?.direccion ?? null],
  );

  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('recambio_solicitado', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [numero, `${to} pidió un recambio del contenedor ${numero} por cuenta corriente`],
  );
  if (alerta) emitAlerta({ ...alerta, cliente_telefono: to });
  emitRecursoActualizado('viajes');

  await clearSesion(to);
  await sendText(
    to,
    `✅ ¡Recambio confirmado! Costo: *${moneda} ${Number(precio).toLocaleString('es-AR')}* — se agregó a tu cuenta corriente.\n\n` +
      'En breve te asignamos chofer para coordinarlo.\n\n' +
      '_Si en un rato no tenés novedades, escribí *asesor*._',
  );
}
