import { query } from '../../../config/db';
import { sendText, sendList, sendButtons, sendLocationRequest } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { datosBancarios } from './pago.flow';
import { obtenerOCrearCliente } from '../../../services/clientes.service';
import { reverseGeocode, CandidatoDireccion } from '../../../services/geocoding.service';
import {
  verificarUbicacionCompleta,
  buscarCandidatosDireccion,
  enviarListaCandidatos,
  elegirCandidato,
  mensajePedirUbicacionPasoAPaso,
  combinarDireccionConIndicacion,
  normalizarIndicacion,
  AVISO_DIRECCION_APROXIMADA,
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
 *   inicio -> ubicacion [-> elegir_candidato_direccion, si escribió texto y
 *   hay >1 resultado] -> confirmar_ubicacion (capa 4) -> indicacion_chofer
 *   -> tipo_lugar -> [barrio_privado] -> emplazamiento -> dia_entrega ->
 *   horario -> [crea el pedido]
 *
 * No se pregunta el departamento por adelantado: siempre se detecta a
 * partir de la ubicación real (pin o dirección escrita, ver
 * verificarUbicacionCompleta en ubicacionZona.helper.ts). Preguntarlo antes
 * era peor, no mejor — un cliente puede no saber en qué departamento cae su
 * dirección (sobre todo cerca de un límite), y si elegía uno y después la
 * ubicación real caía en otro, el bot dejaba "ganar" a lo elegido a mano por
 * sobre la geometría real: quedaba un pedido con la dirección de un
 * departamento pero facturado con la tarifa de otro.
 *
 * Ubicación por texto o por pin: siempre se ofrecen las dos opciones (regla
 * del dueño — hay dispositivos que no dejan compartir el pin). El pin sigue
 * siendo más preciso, pero una dirección escrita que geocodifica bien ya
 * alcanza para avanzar a la capa 4 — no se obliga a mandar el pin después,
 * solo se avisa que es aproximada. Si el nombre de calle se repite en varios
 * departamentos, el candidato ambiguo se resuelve ahí mismo (la lista
 * muestra la dirección completa con su localidad), no preguntando el
 * departamento de antemano.
 *
 * handlePedirNuevoContenedor(): cliente ocasional con contenedor que pide
 * otro — misma dirección (ya verificada antes, no se repite capa 4) u otra
 * (reusa `ubicacion`).
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
  avisoExtra?: string,
): Promise<void> {
  const resumenUbicacion =
    destinoLat != null && destinoLng != null
      ? `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`
      : (destinoDireccion as string);

  const tarifa = await tarifaDeZona(departamento);
  const lineaPrecio = tarifa ? `\nPrecio: *${tarifa.moneda} ${Number(tarifa.precio).toLocaleString('es-AR')}*` : '';

  await sendButtons(
    to,
    `${avisoExtra ? avisoExtra + '\n\n' : ''}📍 Dirección: ${resumenUbicacion}\nZona: *${departamento}*${lineaPrecio}\n\n` +
      `¿Este es el lugar donde va el contenedor, o es desde donde me estás escribiendo?`,
    [
      { id: 'ubicacion_es_destino', title: '📍 Es el destino' },
      { id: 'ubicacion_no', title: '↩️ Mandar otra' },
    ],
  );
  await setSesion({
    ...sesion,
    paso: 'confirmar_ubicacion',
    contexto: { departamento, destinoLat, destinoLng, destinoDireccion },
  });
}

/** Paso "tipo de lugar" — primer dato que el GPS no da (caso borde). */
async function pedirTipoLugar(to: string, sesion: Sesion): Promise<void> {
  await sendList(to, '🏗️ Tipo de lugar', '¿Qué tipo de lugar es la dirección de entrega?', 'Ver opciones', TIPOS_LUGAR);
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
  await sendButtons(to, '🏡 ¿Es en un barrio privado?', [
    { id: 'barrio_privado_si', title: '✅ Sí' },
    { id: 'barrio_privado_no', title: '↩️ No' },
  ]);
  await setSesion({ ...sesion, paso: 'barrio_privado' });
}

/** Paso "¿va dentro del terreno o sobre la vía pública?" — segundo dato que el GPS no da. */
async function pedirEmplazamiento(to: string, sesion: Sesion): Promise<void> {
  // Títulos de botón cortos a propósito: WhatsApp rechaza el mensaje ENTERO
  // si un título de botón supera los 20 caracteres — "🏡 Adentro del
  // terreno" quedaba en 21 y tiraba abajo este mensaje sin ningún error
  // visible para el cliente (el bot se quedaba mudo justo acá).
  await sendButtons(to, '🚧 ¿El contenedor va a quedar adentro del terreno, o sobre la vía pública (vereda/calle)?', [
    { id: 'emplazamiento_terreno', title: '🏡 En el terreno' },
    { id: 'emplazamiento_via_publica', title: '🚧 Vía pública' },
  ]);
  await setSesion({ ...sesion, paso: 'emplazamiento' });
}

/** Paso "elegir día de entrega" — próximos días hábiles, sin domingos. */
async function pedirDiaEntrega(to: string, sesion: Sesion): Promise<void> {
  const dias = proximosDiasHabiles();
  await sendList(
    to,
    '📅 Día de entrega',
    '¿Qué día preferís que te llevemos el contenedor?',
    'Ver días',
    dias.map((d) => ({ id: `dia:${d.fecha}`, title: d.etiqueta })),
  );
  await setSesion({ ...sesion, paso: 'dia_entrega' });
}

/**
 * Ubicación de entrega: detecta el departamento a partir de la ubicación, ya
 * sea pin GPS o dirección escrita (geocodificada) — nunca se pregunta antes
 * (ver comentario al principio del archivo). Si no cae en ninguna zona
 * conocida -> caso borde "fuera de zona". Si cae en una zona sin tarifa
 * activa, se le avisa. Si todo da bien, avanza a la confirmación de capa 4.
 */
async function manejarUbicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (m.tipo === 'location' && m.lat != null && m.lng != null) {
    const direccionCruda = m.ubicacionDireccion || m.ubicacionNombre || null;
    const resultado = await verificarUbicacionCompleta(m, sesion, m.lat, m.lng, direccionCruda, { requiereTarifa: true });
    if (!resultado.ok) return;

    const destinoDireccion = direccionCruda ?? (await reverseGeocode(m.lat, m.lng));
    await avanzarAConfirmarUbicacion(to, sesion, resultado.departamento, m.lat, m.lng, destinoDireccion);
    return;
  }

  if (m.tipo === 'text' && m.texto && m.texto.trim().length >= 5) {
    const resultado = await buscarCandidatosDireccion(m.texto.trim());

    if (resultado.tipo === 'sin_resultados') {
      await sendText(
        to,
        '🙁 No encontramos esa dirección. Probá describirla distinto (calle + altura + localidad + departamento), ' +
          'o tocá el botón de "Enviar ubicación" para mandar el pin.',
      );
      return;
    }
    if (resultado.tipo === 'un_candidato') {
      const r = await verificarUbicacionCompleta(m, sesion, resultado.candidato.lat, resultado.candidato.lng, resultado.candidato.direccion, {
        requiereTarifa: true,
      });
      if (!r.ok) return;
      await avanzarAConfirmarUbicacion(to, sesion, r.departamento, resultado.candidato.lat, resultado.candidato.lng, resultado.candidato.direccion, AVISO_DIRECCION_APROXIMADA);
      return;
    }
    await enviarListaCandidatos(to, resultado.candidatos);
    await setSesion({ ...sesion, paso: 'elegir_candidato_direccion', contexto: { candidatos: resultado.candidatos } });
    return;
  }

  await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso('📍 Para cotizar necesito verificar tu ubicación.'));
}

/** El cliente eligió una de las direcciones candidatas de la lista (ver enviarListaCandidatos). */
async function manejarEleccionCandidato(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const candidatos = (sesion.contexto.candidatos as CandidatoDireccion[]) ?? [];

  const elegido = elegirCandidato(m, candidatos);
  if (!elegido) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una de las direcciones de la lista. 👆');
    return;
  }

  const resultado = await verificarUbicacionCompleta(m, sesion, elegido.lat, elegido.lng, elegido.direccion, { requiereTarifa: true });
  if (!resultado.ok) return;
  await avanzarAConfirmarUbicacion(to, sesion, resultado.departamento, elegido.lat, elegido.lng, elegido.direccion, AVISO_DIRECCION_APROXIMADA);
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
    await setSesion({ telefono: to, flujo: 'cotizacion', paso: 'ubicacion', contexto: {} });
    await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso('📍 ¿A dónde va el contenedor nuevo?'));
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
    contexto: { departamento: zona, destinoLat, destinoLng, destinoDireccion },
  });
}

export async function handleCotizacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'ubicacion') {
    return manejarUbicacion(m, sesion);
  }
  if (sesion.paso === 'elegir_ubicacion_nuevo') {
    return manejarEleccionUbicacionNuevo(m, sesion);
  }
  if (sesion.paso === 'elegir_candidato_direccion') {
    return manejarEleccionCandidato(m, sesion);
  }

  // Paso 0: arranque -> directo a pedir la ubicación (nunca se pregunta el
  // departamento antes, ver comentario al principio del archivo).
  if (!sesion.paso || sesion.paso === 'inicio') {
    await setSesion({ telefono: to, flujo: 'cotizacion', paso: 'ubicacion', contexto: {} });
    await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso('📍 Para cotizar necesito verificar tu ubicación.'));
    return;
  }

  // Paso 3 (capa 4): confirmó (o no) que ahí va el contenedor.
  if (sesion.paso === 'confirmar_ubicacion') {
    const { departamento, destinoLat, destinoLng, destinoDireccion } = sesion.contexto as {
      departamento: string;
      destinoLat: number | null;
      destinoLng: number | null;
      destinoDireccion: string | null;
    };

    if (m.seleccionId === 'ubicacion_no') {
      await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso('📍 Dale, mandámela de nuevo.'));
      await setSesion({ ...sesion, paso: 'ubicacion', contexto: {} });
      return;
    }
    if (m.seleccionId !== 'ubicacion_es_destino') {
      await manejarRespuestaInvalida(
        m,
        'Elegí "📍 Es el destino" o "↩️ Mandar otra".\n\n_Escribí *menú* para volver al inicio._',
      );
      return;
    }

    await sendText(to, '🚚 ¿Alguna indicación para el chofer (portón, timbre, entre calles)? Si no hay, escribí "no".');
    await setSesion({ ...sesion, paso: 'indicacion_chofer', contexto: { departamento, destinoLat, destinoLng, destinoDireccion } });
    return;
  }

  // Paso 3b: indicación libre para el chofer, ya con la ubicación confirmada.
  if (sesion.paso === 'indicacion_chofer') {
    const { departamento, destinoLat, destinoLng, destinoDireccion } = sesion.contexto as {
      departamento: string;
      destinoLat: number | null;
      destinoLng: number | null;
      destinoDireccion: string | null;
    };
    if (m.tipo !== 'text' || !m.texto) {
      await sendText(to, '🚚 Contame si hay alguna indicación para el chofer, o escribí "no".');
      return;
    }
    const indicacion = normalizarIndicacion(m.texto);
    const destinoDireccionFinal = combinarDireccionConIndicacion(destinoDireccion, indicacion);
    await pedirTipoLugar(to, { ...sesion, contexto: { departamento, destinoLat, destinoLng, destinoDireccion: destinoDireccionFinal } });
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
    await pedirEmplazamiento(to, nuevaSesion);
    return;
  }

  // Paso 4b: solo para "Casa" — ¿es en un barrio privado? (acceso restringido, ver HORARIO_BARRIO_PRIVADO)
  if (sesion.paso === 'barrio_privado') {
    if (m.seleccionId === 'barrio_privado_si') {
      await pedirEmplazamiento(to, { ...sesion, contexto: { ...sesion.contexto, enBarrioPrivado: true } });
      return;
    }
    if (m.seleccionId === 'barrio_privado_no') {
      await pedirEmplazamiento(to, { ...sesion, contexto: { ...sesion.contexto, enBarrioPrivado: false } });
      return;
    }
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí" o "↩️ No".');
    return;
  }

  // Paso 5: ¿va adentro del terreno o sobre la vía pública?
  if (sesion.paso === 'emplazamiento') {
    if (m.seleccionId === 'emplazamiento_via_publica') {
      await sendText(
        to,
        '⚠️ Ojo: si el contenedor va sobre la vereda o la calle, hace falta el *permiso municipal de ocupación de vía pública*. ' +
          'Lo tenés que gestionar vos — nosotros seguimos con la coordinación igual.',
      );
      await pedirDiaEntrega(to, { ...sesion, contexto: { ...sesion.contexto, enViaPublica: true } });
      return;
    }
    if (m.seleccionId === 'emplazamiento_terreno') {
      await pedirDiaEntrega(to, { ...sesion, contexto: { ...sesion.contexto, enViaPublica: false } });
      return;
    }
    await manejarRespuestaInvalida(m, 'Elegí "🏡 En el terreno" o "🚧 Vía pública".');
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
      await finalizarPedido(to, m, nuevaSesion, HORARIO_BARRIO_PRIVADO);
      return;
    }

    await pedirHorarioPreferido(to, `🕐 ¿En qué franja horaria preferís que te lo llevemos el ${formatearFechaLarga(fechaEntrega)}?`);
    await setSesion({ ...nuevaSesion, paso: 'horario' });
    return;
  }

  // Paso 7: eligió la franja horaria -> recién ahí se crea el pedido y se cierra.
  if (sesion.paso === 'horario') {
    const opcion = OPCIONES_HORARIO.find((o) => o.id === m.seleccionId);
    if (!opcion) {
      await pedirHorarioPreferido(to, 'Elegí una de las opciones de abajo. 👇');
      return;
    }
    await finalizarPedido(to, m, sesion, opcion);
    return;
  }
}

/** Crea el pedido y cierra el flujo — sea con la franja elegida por botones o la fija de barrio privado. */
async function finalizarPedido(to: string, m: MensajeEntrante, sesion: Sesion, opcion: { title: string }): Promise<void> {
  const { departamento, destinoLat, destinoLng, destinoDireccion, tipoLugar, enViaPublica, fechaEntrega } = sesion.contexto as {
    departamento: string;
    destinoLat: number | null;
    destinoLng: number | null;
    destinoDireccion: string | null;
    tipoLugar: string | null;
    enViaPublica: boolean | null;
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

  const [pedido] = await query<{ numero_pedido: number }>(
    `INSERT INTO pedidos (
       cliente_telefono, cliente_nombre, zona, precio, estado, destino_lat, destino_lng, destino_direccion,
       horario_preferido, tipo_lugar, en_via_publica, fecha_entrega, fecha_retiro_estimada
     ) VALUES ($1,$2,$3,$4,'cotizado',$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING numero_pedido`,
    [
      to, m.nombrePerfil ?? null, departamento, precio, destinoLat, destinoLng, destinoDireccion,
      opcion.title, tipoLugar ?? null, enViaPublica ?? null, fechaEntrega, fechaRetiroEstimada,
    ],
  );
  // Alta/actualización en el padrón de clientes (ver clientes.service.ts) —
  // así la pantalla Clientes del panel refleja a todo el que cotizó, no
  // solo a quien pidió cuenta corriente.
  obtenerOCrearCliente(to, m.nombrePerfil).catch((e) => console.error('Error dando de alta al cliente:', e));

  await sendText(
    to,
    `📦 *Pedido #${pedido.numero_pedido} — ${departamento}*\n` +
      `Dirección: ${destinoDireccion ?? `ubicación compartida (${destinoLat}, ${destinoLng})`}\n` +
      `Fecha de entrega: ${formatearFechaLarga(fechaEntrega)}\n` +
      `Franja horaria: ${opcion.title}\n` +
      `Importe: *${moneda} ${Number(precio).toLocaleString('es-AR')}*\n` +
      `Fecha estimada de retiro: ${formatearFechaLarga(fechaRetiroEstimada)}\n\n` +
      `Para reservarlo, hacé el pago con estos datos:\n\n` +
      `${datosBancarios()}\n\n` +
      `Y enviános el comprobante por este chat 📎\n` +
      `(escribí *Ya pagué* o adjuntá directamente la foto/PDF).\n\n` +
      `_Escribí *menú* para volver al inicio en cualquier momento._`,
  );
  await clearSesion(to);
}
