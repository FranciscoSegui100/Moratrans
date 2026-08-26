import { query } from '../../../config/db';
import { sendText, sendList, sendButtons, sendLocationRequest } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { datosBancarios } from './pago.flow';
import { obtenerOCrearCliente, necesitaNombre } from '../../../services/clientes.service';
import { reverseGeocode } from '../../../services/geocoding.service';
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
import { OPCIONES_HORARIO, pedirHorarioPreferido } from './horarioPreferido.flow';
import { contenedoresDelCliente } from '../../../services/contenedorCliente.service';
import { proximosDiasHabiles, formatearFechaLarga, sumarDias } from '../../../services/diasHabiles.service';
import { manejarRespuestaInvalida } from '../estados';
import { TIPOS_LUGAR, DIAS_ALQUILER_ANTES_RETIRO, HORARIO_BARRIO_PRIVADO } from '../../../config/bot.config';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Flujo de cotización / pedido (menú cerrado):
 *   inicio -> elegir_departamento -> elegir_metodo_ubicacion ->
 *   [ubicacion_pin [-> confirmar_departamento_pin, si el pin no coincide
 *   con el departamento elegido] | ubicacion_texto] -> confirmar_ubicacion
 *   (capa 4) -> indicacion_chofer -> tipo_lugar -> [barrio_privado] ->
 *   dia_entrega -> horario -> confirmar_resumen -> [pedir_nombre_pedido,
 *   si es la primera vez que este teléfono confirma un pedido] -> [crea el
 *   pedido]
 *
 * Se vuelve a preguntar el departamento primero (a diferencia de una
 * versión anterior de este flujo que lo sacó): el cliente elige a mano, y
 * después dos formas de dar la dirección exacta dentro de ese
 * departamento:
 *  1. Pin GPS (prioritario, se aclara que es más preciso) — se sigue
 *     verificando por geometría real (point-in-polygon). Si el pin cae en
 *     otro departamento del elegido, no se resuelve solo: se le pregunta al
 *     cliente si quiere cambiar la cotización al departamento real o volver
 *     a mandar la ubicación (ver verificarUbicacionConDepartamentoElegido /
 *     preguntarMismatchDepartamento en ubicacionZona.helper.ts) — sin
 *     mostrar precios en esa pregunta, para no influenciar la respuesta.
 *  2. Calle y número escritos a mano, del departamento ya elegido — NO se
 *     busca en el mapa (nada de geocodificar texto libre, con su riesgo de
 *     ambigüedad entre calles repetidas). Se guarda tal cual la escribe el
 *     cliente (`direccion_verificada = false`), y es el propio cliente quien
 *     la confirma, resaltada en negrita, en la capa 4.
 * En ambos casos, recién en la confirmación final (capa 4) se muestra el
 * precio — así el cliente no elige departamento en base al precio.
 *
 * handlePedirNuevoContenedor(): cliente ocasional con contenedor que pide
 * otro — misma dirección (ya verificada antes, no se repite nada de esto) u
 * otra (arranca de nuevo por elegir_departamento).
 */

/** Precio activo de una zona, o null si no está cargada/activa. */
async function tarifaDeZona(departamento: string): Promise<{ precio: string; moneda: string } | null> {
  const [tarifa] = await query<{ precio: string; moneda: string }>(
    'SELECT precio, moneda FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [departamento],
  );
  return tarifa ?? null;
}

/**
 * Capa 4 — doble confirmación explícita, con la pregunta puntual del dueño:
 * distingue "acá va el contenedor" de "acá estoy yo escribiendo". Muestra
 * dirección + zona + precio antes de preguntar. Deja el pedido a un paso de
 * cerrarse recién cuando el cliente confirma.
 */
async function avanzarAConfirmarUbicacion(
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

  const tarifa = await tarifaDeZona(departamento);
  const lineaPrecio = tarifa ? `\nPrecio: *${tarifa.moneda} ${Number(tarifa.precio).toLocaleString('es-AR')}*` : '';

  await sendButtons(
    to,
    `📍 Dirección: ${resumenUbicacion}\nZona: *${departamento}*${lineaPrecio}\n\n` +
      `¿Confirmás que esta es la dirección exacta donde debe entregarse el contenedor?`,
    [
      { id: 'ubicacion_es_destino', title: '✅ Sí, es correcta' },
      { id: 'ubicacion_no', title: '↩️ Mandar otra' },
    ],
  );
  await setSesion({
    ...sesion,
    paso: 'confirmar_ubicacion',
    contexto: { departamento, destinoLat, destinoLng, destinoDireccion, direccionVerificada },
  });
}

/** Paso "tipo de lugar" — primer dato que el GPS no da (caso borde). */
async function pedirTipoLugar(to: string, sesion: Sesion): Promise<void> {
  await sendList(
    to,
    '🏗️ Tipo de lugar',
    '¿Qué tipo de lugar es la dirección de entrega? Nos ayuda a coordinar mejor el acceso del camión.',
    'Ver opciones',
    TIPOS_LUGAR,
  );
  await setSesion({ ...sesion, paso: 'tipo_lugar' });
}

/**
 * Solo si el tipo de lugar es "Casa" u "Obra" (una obra puede estar dentro
 * de un barrio privado en construcción): los barrios privados suelen tener
 * acceso restringido, así que en vez del selector normal de franja horaria
 * (Mañana/Tarde) se usa una única franja fija (ver HORARIO_BARRIO_PRIVADO en
 * bot.config.ts) — no aplica a comercio ni consorcio.
 */
async function pedirBarrioPrivado(to: string, sesion: Sesion): Promise<void> {
  await sendButtons(
    to,
    '🏡 ¿La entrega es dentro de un barrio privado? Suelen tener horario de acceso restringido, así lo coordinamos bien.',
    [
      { id: 'barrio_privado_si', title: '✅ Sí' },
      { id: 'barrio_privado_no', title: '↩️ No' },
    ],
  );
  await setSesion({ ...sesion, paso: 'barrio_privado' });
}

/** Próximos días hábiles que se le ofrecen para elegir la entrega (sin domingos). */
const DIAS_A_OFRECER_ENTREGA = 3;

/** Paso "elegir día de entrega" — próximos días hábiles, sin domingos. */
async function pedirDiaEntrega(to: string, sesion: Sesion): Promise<void> {
  const dias = proximosDiasHabiles(DIAS_A_OFRECER_ENTREGA);
  await sendList(
    to,
    '📅 Día de entrega',
    '¿Qué día preferís que te llevemos el contenedor?',
    'Ver días',
    dias.map((d) => ({ id: `dia:${d.fecha}`, title: d.etiqueta })),
  );
  await setSesion({ ...sesion, paso: 'dia_entrega' });
}

/** Paso "elegir_metodo_ubicacion": pin (prioritario) o escribir la dirección. */
async function manejarMetodoUbicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = sesion.contexto.departamento as string;

  if (m.seleccionId === 'metodo_pin') {
    await setSesion({ ...sesion, paso: 'ubicacion_pin' });
    await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Mandanos el pin de la dirección en *${departamento}*.`));
    return;
  }
  if (m.seleccionId === 'metodo_texto') {
    await setSesion({ ...sesion, paso: 'ubicacion_texto' });
    await sendText(to, mensajePedirCalleNumero(departamento));
    return;
  }
  await manejarRespuestaInvalida(m, 'Elegí una de las opciones de abajo. 👇');
}

/**
 * Paso "ubicacion_pin": pin real (o link de Maps) — se verifica contra el
 * departamento ya elegido por geometría real (ver
 * verificarUbicacionConDepartamentoElegido). Si no coincide, no se decide
 * solo (ver manejarMismatchDepartamento).
 */
async function manejarUbicacionPin(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = sesion.contexto.departamento as string;
  const ubicacion = await resolverUbicacionMensaje(m);

  if (ubicacion.tipo === 'ubicacion') {
    const destinoDireccion = ubicacion.direccionCruda ?? (await reverseGeocode(ubicacion.lat, ubicacion.lng));
    const resultado = await verificarUbicacionConDepartamentoElegido(m, sesion, ubicacion.lat, ubicacion.lng, destinoDireccion, departamento, {
      requiereTarifa: true,
    });
    if (!resultado.ok) return;

    if (!resultado.coincide) {
      await preguntarMismatchDepartamento(to, resultado.departamentoElegido, resultado.departamentoDetectado);
      await setSesion({
        ...sesion,
        paso: 'confirmar_departamento_pin',
        contexto: { departamento, departamentoDetectado: resultado.departamentoDetectado, destinoLat: ubicacion.lat, destinoLng: ubicacion.lng, destinoDireccion },
      });
      return;
    }

    await avanzarAConfirmarUbicacion(to, sesion, resultado.departamento, ubicacion.lat, ubicacion.lng, destinoDireccion, true);
    return;
  }

  if (ubicacion.tipo === 'link_invalido') {
    await sendText(to, '🙁 No pude leer ese link de Maps. Probá copiarlo de nuevo desde el botón "Compartir", o usá el botón "Enviar ubicación" de abajo.');
    return;
  }

  await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Mandanos el pin de la dirección en *${departamento}*.`));
}

/** Paso "confirmar_departamento_pin": el pin no coincidía con el departamento elegido — el cliente decide cuál vale. */
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
    await setSesion({ ...sesion, paso: 'ubicacion_pin', contexto: { departamento } });
    await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Dale, mandanos de nuevo el pin de la dirección en *${departamento}*.`));
    return;
  }
  if (m.seleccionId !== 'depto_cambiar') {
    await manejarRespuestaInvalida(m, 'Elegí una de las opciones de abajo. 👇');
    return;
  }

  const tarifa = await tarifaDeZona(departamentoDetectado);
  if (!tarifa) {
    await sendText(to, `🙁 No tenemos tarifa activa en *${departamentoDetectado}* todavía. Escribí *asesor* para coordinarlo.`);
    await clearSesion(to);
    return;
  }
  await avanzarAConfirmarUbicacion(to, sesion, departamentoDetectado, destinoLat, destinoLng, destinoDireccion, true);
}

/** Paso "ubicacion_texto": calle y número escritos a mano, del departamento ya elegido — se guarda tal cual, sin buscarla en el mapa. */
async function manejarUbicacionTexto(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = sesion.contexto.departamento as string;

  if (m.tipo !== 'text' || !m.texto || m.texto.trim().length < 4) {
    await sendText(to, mensajePedirCalleNumero(departamento));
    return;
  }

  await avanzarAConfirmarUbicacion(to, sesion, departamento, null, null, m.texto.trim(), false);
}

const BOTONES_UBICACION_NUEVO = [
  { id: 'nuevo_misma_ubicacion', title: '✅ Misma dirección' },
  { id: 'nuevo_otra_ubicacion', title: '📍 Otra dirección' },
];

/**
 * "Pedir nuevo contenedor": cliente ocasional con un contenedor entregado
 * que quiere uno más — se cobra y se paga igual que cualquier entrega nueva
 * (comprobante + validación de un operador), no como "Pedir entrega"
 * (exclusivo de cuenta corriente). En vez de arrancar de cero, ofrece
 * reusar la ubicación ya verificada de su contenedor actual (caso borde
 * "cliente que ya pidió antes") o verificar una nueva.
 */
export async function handlePedirNuevoContenedor(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const conts = await contenedoresDelCliente(to);
  if (conts.length === 0) {
    await clearSesion(to);
    await sendText(
      to,
      '🙁 No encontramos ningún contenedor entregado a tu nombre todavía. Escribí *Cotizar* para pedir el primero, o *asesor* si creés que es un error.',
    );
    return;
  }
  const cont = conts[0];

  await setSesion({
    telefono: to,
    flujo: 'cotizacion',
    paso: 'elegir_ubicacion_nuevo',
    contexto: { zona: cont.zona, destinoDireccion: cont.destino_direccion, destinoLat: cont.destino_lat, destinoLng: cont.destino_lng },
  });
  await sendButtons(to, '📦 ¿A dónde llevamos el contenedor nuevo?', BOTONES_UBICACION_NUEVO);
}

/** "Misma dirección" ya fue verificada en una entrega anterior -> se salta la capa 4, va directo a tipo de lugar. */
async function manejarEleccionUbicacionNuevo(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (m.seleccionId === 'nuevo_otra_ubicacion') {
    if (!(await pedirDepartamento(to, '📍 ¿A qué *departamento* llevamos el contenedor nuevo?'))) {
      await clearSesion(to);
      return;
    }
    await setSesion({ telefono: to, flujo: 'cotizacion', paso: 'elegir_departamento', contexto: {} });
    return;
  }
  if (m.seleccionId !== 'nuevo_misma_ubicacion') {
    await manejarRespuestaInvalida(m, 'Elegí una de las opciones de abajo. 👇');
    return;
  }

  const { zona, destinoDireccion, destinoLat, destinoLng } = sesion.contexto as {
    zona: string | null;
    destinoDireccion: string | null;
    destinoLat: number | null;
    destinoLng: number | null;
  };
  if (!zona) {
    await clearSesion(to);
    await sendText(to, '🙁 No tenemos la zona cargada para tu contenedor actual. Escribí *asesor* para coordinarlo.');
    return;
  }
  const tarifa = await tarifaDeZona(zona);
  if (!tarifa) {
    await clearSesion(to);
    await sendText(to, '🙁 No encontramos la tarifa para tu zona. Escribí *asesor* para coordinarlo.');
    return;
  }

  await pedirTipoLugar(to, {
    telefono: to,
    flujo: 'cotizacion',
    paso: 'tipo_lugar',
    contexto: { departamento: zona, destinoLat, destinoLng, destinoDireccion, direccionVerificada: true },
  });
}

export async function handleCotizacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'elegir_metodo_ubicacion') {
    return manejarMetodoUbicacion(m, sesion);
  }
  if (sesion.paso === 'ubicacion_pin') {
    return manejarUbicacionPin(m, sesion);
  }
  if (sesion.paso === 'confirmar_departamento_pin') {
    return manejarMismatchDepartamento(m, sesion);
  }
  if (sesion.paso === 'ubicacion_texto') {
    return manejarUbicacionTexto(m, sesion);
  }
  if (sesion.paso === 'elegir_ubicacion_nuevo') {
    return manejarEleccionUbicacionNuevo(m, sesion);
  }

  // Paso 0: arranque -> elegir departamento primero.
  if (!sesion.paso || sesion.paso === 'inicio') {
    if (!(await pedirDepartamento(to, '¡Genial! Elegí el *departamento* de destino:'))) {
      await clearSesion(to);
      return;
    }
    await setSesion({ telefono: to, flujo: 'cotizacion', paso: 'elegir_departamento', contexto: {} });
    return;
  }

  // Paso 1: recibió el departamento -> elegir cómo dar la dirección.
  if (sesion.paso === 'elegir_departamento') {
    const departamento = departamentoElegido(m);
    if (!departamento) {
      await manejarRespuestaInvalida(m, 'Por favor, elegí una opción de la lista.\n\n_Escribí *menú* para volver al inicio._');
      return;
    }
    await setSesion({ ...sesion, paso: 'elegir_metodo_ubicacion', contexto: { departamento } });
    await pedirMetodoUbicacion(to, departamento);
    return;
  }

  // Paso 3 (capa 4): confirmó (o no) que ahí va el contenedor.
  if (sesion.paso === 'confirmar_ubicacion') {
    const { departamento, destinoLat, destinoLng, destinoDireccion, direccionVerificada } = sesion.contexto as {
      departamento: string;
      destinoLat: number | null;
      destinoLng: number | null;
      destinoDireccion: string | null;
      direccionVerificada: boolean;
    };

    if (m.seleccionId === 'ubicacion_no') {
      await setSesion({ ...sesion, paso: 'elegir_metodo_ubicacion', contexto: { departamento } });
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

    await sendText(
      to,
      '🚚 ¿Alguna indicación para el chofer que le facilite llegar (portón, timbre, entre calles, un punto de referencia)?\n\n' +
        'Si no hay ninguna, escribí *no*.',
    );
    await setSesion({ ...sesion, paso: 'indicacion_chofer', contexto: { departamento, destinoLat, destinoLng, destinoDireccion, direccionVerificada } });
    return;
  }

  // Paso 3b: indicación libre para el chofer, ya con la ubicación confirmada.
  if (sesion.paso === 'indicacion_chofer') {
    const { departamento, destinoLat, destinoLng, destinoDireccion, direccionVerificada } = sesion.contexto as {
      departamento: string;
      destinoLat: number | null;
      destinoLng: number | null;
      destinoDireccion: string | null;
      direccionVerificada: boolean;
    };
    if (m.tipo !== 'text' || !m.texto) {
      await sendText(to, '🚚 Contame si hay alguna indicación para el chofer, o escribí *no*.');
      return;
    }
    const indicacion = normalizarIndicacion(m.texto);
    const destinoDireccionFinal = combinarDireccionConIndicacion(destinoDireccion, indicacion);
    await pedirTipoLugar(to, { ...sesion, contexto: { departamento, destinoLat, destinoLng, destinoDireccion: destinoDireccionFinal, direccionVerificada } });
    return;
  }

  // Paso 4: tipo de lugar (dato que el GPS no da).
  if (sesion.paso === 'tipo_lugar') {
    const opcion = TIPOS_LUGAR.find((o) => o.id === m.seleccionId);
    if (!opcion) {
      await manejarRespuestaInvalida(m, 'Por favor, elegí una opción de la lista. 👆');
      return;
    }
    const nuevaSesion = { ...sesion, contexto: { ...sesion.contexto, tipoLugar: opcion.id.replace('lugar_', '') } };
    if (opcion.id === 'lugar_casa' || opcion.id === 'lugar_obra') {
      await pedirBarrioPrivado(to, nuevaSesion);
      return;
    }
    await pedirDiaEntrega(to, nuevaSesion);
    return;
  }

  // Paso 4b: solo para "Casa" — ¿es en un barrio privado? (acceso restringido, ver HORARIO_BARRIO_PRIVADO)
  if (sesion.paso === 'barrio_privado') {
    if (m.seleccionId === 'barrio_privado_si') {
      await pedirDiaEntrega(to, { ...sesion, contexto: { ...sesion.contexto, enBarrioPrivado: true } });
      return;
    }
    if (m.seleccionId === 'barrio_privado_no') {
      await pedirDiaEntrega(to, { ...sesion, contexto: { ...sesion.contexto, enBarrioPrivado: false } });
      return;
    }
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí" o "↩️ No".');
    return;
  }

  // Paso 6: día de entrega (próximos días hábiles, sin domingos).
  if (sesion.paso === 'dia_entrega') {
    if (!m.seleccionId?.startsWith('dia:')) {
      await manejarRespuestaInvalida(m, 'Por favor, elegí uno de los días de la lista. 👆');
      return;
    }
    const fechaEntrega = m.seleccionId.replace('dia:', '');
    const nuevaSesion = { ...sesion, contexto: { ...sesion.contexto, fechaEntrega } };

    // Barrio privado: acceso restringido, franja horaria fija (ver
    // HORARIO_BARRIO_PRIVADO) — no tiene sentido ofrecerle Mañana/Tarde.
    if (sesion.contexto.enBarrioPrivado) {
      await sendText(
        to,
        `🏡 Como es en un barrio privado, coordinamos la entrega dentro del horario de acceso: *${HORARIO_BARRIO_PRIVADO.title}*.`,
      );
      await mostrarResumenYConfirmar(to, nuevaSesion, HORARIO_BARRIO_PRIVADO);
      return;
    }

    await pedirHorarioPreferido(to, `🕐 ¿En qué franja horaria preferís que te lo llevemos el ${formatearFechaLarga(fechaEntrega)}?`);
    await setSesion({ ...nuevaSesion, paso: 'horario' });
    return;
  }

  // Paso 7: eligió la franja horaria -> muestra el resumen completo antes de crear el pedido.
  if (sesion.paso === 'horario') {
    const opcion = OPCIONES_HORARIO.find((o) => o.id === m.seleccionId);
    if (!opcion) {
      await pedirHorarioPreferido(to, 'Elegí una de las opciones de abajo. 👇');
      return;
    }
    await mostrarResumenYConfirmar(to, sesion, opcion);
    return;
  }

  // Paso 8 (resumen final): confirmó (o no) todo el pedido -> recién ahí se crea y se muestra el pago.
  if (sesion.paso === 'confirmar_resumen') {
    return manejarConfirmacionResumen(m, sesion);
  }

  // Paso 8b: solo si es la primera vez que este teléfono confirma un pedido.
  if (sesion.paso === 'pedir_nombre_pedido') {
    return manejarNombrePedido(m, sesion);
  }
}

/**
 * Muestra el resumen completo del pedido (dirección resaltada en negrita,
 * zona, precio, fecha y franja) y pide confirmación explícita antes de
 * crear nada — recién si confirma se registra el pedido y se le pasan los
 * datos para transferir (ver finalizarPedido). El precio se congela acá
 * (mismo criterio que antes): si más tarde la tarifa cambia, este pedido ya
 * cerrado no se ve afectado.
 */
async function mostrarResumenYConfirmar(to: string, sesion: Sesion, opcion: { title: string }): Promise<void> {
  const { departamento, destinoLat, destinoLng, destinoDireccion, direccionVerificada, tipoLugar, fechaEntrega } = sesion.contexto as {
    departamento: string;
    destinoLat: number | null;
    destinoLng: number | null;
    destinoDireccion: string | null;
    direccionVerificada: boolean;
    tipoLugar: string | null;
    fechaEntrega: string;
  };

  const tarifa = await tarifaDeZona(departamento);
  if (!tarifa) {
    await sendText(to, '🙁 Esa tarifa ya no está disponible. Escribí *Cotizar* para reintentar.');
    await clearSesion(to);
    return;
  }
  const { precio, moneda } = tarifa;
  const fechaRetiroEstimada = sumarDias(fechaEntrega, DIAS_ALQUILER_ANTES_RETIRO);
  const resumenUbicacion =
    destinoLat != null && destinoLng != null
      ? `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`
      : `*${destinoDireccion}*`;

  await sendButtons(
    to,
    `📦 *Resumen de tu pedido*\n\n` +
      `📍 Dirección: ${resumenUbicacion}\n` +
      `Zona: *${departamento}*\n` +
      `Precio: *${moneda} ${Number(precio).toLocaleString('es-AR')}*\n` +
      `Fecha de entrega: ${formatearFechaLarga(fechaEntrega)}\n` +
      `Franja horaria: ${opcion.title}\n` +
      `Fecha estimada de retiro: ${formatearFechaLarga(fechaRetiroEstimada)}\n\n` +
      `¿Confirmás el pedido?`,
    [
      { id: 'resumen_pedido_si', title: '✅ Sí, confirmar' },
      { id: 'resumen_pedido_no', title: '↩️ Cancelar' },
    ],
  );
  await setSesion({
    ...sesion,
    paso: 'confirmar_resumen',
    contexto: { departamento, destinoLat, destinoLng, destinoDireccion, direccionVerificada, tipoLugar, fechaEntrega, horarioTitle: opcion.title, precio, moneda, fechaRetiroEstimada },
  });
}

async function manejarConfirmacionResumen(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'resumen_pedido_no') {
    await clearSesion(to);
    await sendText(to, '👍 Sin problema, no quedó nada guardado. Escribí *Cotizar* cuando quieras volver a intentarlo, o *menú* para ver otras opciones.');
    return;
  }
  if (m.seleccionId !== 'resumen_pedido_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, confirmar" o "↩️ Cancelar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }

  // El nombre de perfil de WhatsApp no siempre está puesto — recién acá, al
  // confirmar de verdad un pedido (no en cualquier mensaje), se le pregunta
  // nombre y apellido si todavía no lo tenemos guardado. Así no se da de
  // alta un cliente por cada teléfono que solo miró el menú.
  if (await necesitaNombre(to)) {
    await sendText(to, MENSAJE_PEDIR_NOMBRE);
    await setSesion({ ...sesion, paso: 'pedir_nombre_pedido' });
    return;
  }
  await finalizarPedido(to, m, sesion);
}

const MENSAJE_PEDIR_NOMBRE = '🙋 Antes de confirmar tu pedido, decime tu *nombre y apellido* para dejarlo registrado en tu cuenta.';

async function manejarNombrePedido(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const nombre = (m.texto ?? '').trim();
  if (m.tipo !== 'text' || nombre.length < 2) {
    await sendText(to, MENSAJE_PEDIR_NOMBRE);
    return;
  }
  await obtenerOCrearCliente(to, nombre);
  await finalizarPedido(to, m, sesion);
}

/** Crea el pedido en la base y le pasa los datos para transferir — recién acá, con el resumen ya confirmado. */
async function finalizarPedido(to: string, m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const { departamento, destinoLat, destinoLng, destinoDireccion, direccionVerificada, tipoLugar, fechaEntrega, horarioTitle, precio, moneda, fechaRetiroEstimada } = sesion.contexto as {
    departamento: string;
    destinoLat: number | null;
    destinoLng: number | null;
    destinoDireccion: string | null;
    direccionVerificada: boolean;
    tipoLugar: string | null;
    fechaEntrega: string;
    horarioTitle: string;
    precio: string;
    moneda: string;
    fechaRetiroEstimada: string;
  };

  const [pedido] = await query<{ numero_pedido: number }>(
    `INSERT INTO pedidos (
       cliente_telefono, cliente_nombre, zona, precio, estado, destino_lat, destino_lng, destino_direccion,
       direccion_verificada, horario_preferido, tipo_lugar, fecha_entrega, fecha_retiro_estimada
     ) VALUES ($1,$2,$3,$4,'cotizado',$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING numero_pedido`,
    [
      to, m.nombrePerfil ?? null, departamento, precio, destinoLat, destinoLng, destinoDireccion,
      direccionVerificada, horarioTitle, tipoLugar ?? null, fechaEntrega, fechaRetiroEstimada,
    ],
  );
  // El cliente ya quedó dado de alta en `clientes` antes de llegar acá (ver
  // necesitaNombre/manejarNombrePedido más arriba) — no hace falta repetirlo.

  await sendText(
    to,
    `✅ *Pedido #${pedido.numero_pedido} confirmado*\n\n` +
      `Para reservarlo, hacé el pago con estos datos:\n\n` +
      `${datosBancarios()}\n\n` +
      `Y enviános el comprobante por este chat 📎\n` +
      `(escribí *Ya pagué* o adjuntá directamente la foto/PDF).\n\n` +
      `¡Gracias por elegir a *MoraTrans*! 🚚\n\n` +
      `_Escribí *menú* para volver al inicio en cualquier momento._`,
  );
  await clearSesion(to);
}
