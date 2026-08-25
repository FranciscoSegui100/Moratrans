import { query } from '../../../config/db';
import { sendText, sendList, sendButtons, sendLocationRequest } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { datosBancarios } from './pago.flow';
import { obtenerOCrearCliente, esClienteNuevo } from '../../../services/clientes.service';
import { reverseGeocode, CandidatoDireccion } from '../../../services/geocoding.service';
import {
  verificarUbicacionCompleta,
  buscarCandidatosDireccion,
  enviarListaCandidatos,
  elegirCandidato,
  mensajePedirUbicacionPasoAPaso,
  combinarDireccionConIndicacion,
  normalizarIndicacion,
  armarDireccionBusqueda,
  AVISO_DIRECCION_APROXIMADA,
  ResultadoVerificacionZona,
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
 *   inicio -> elegir_departamento -> ubicacion -> [elegir_candidato_direccion, si escribió
 *   texto y hay >1 resultado] -> [confirmar_departamento_detectado, si la dirección no matchea
 *   el departamento elegido] -> confirmar_ubicacion (capa 4) -> tipo_lugar -> emplazamiento
 *   -> dia_entrega -> horario -> [crea el pedido]
 *
 * Ubicación por texto o por pin: siempre se ofrecen las dos opciones (regla
 * del dueño — hay dispositivos que no dejan compartir el pin). El pin sigue
 * siendo más preciso, pero una dirección escrita que geocodifica bien
 * (calle + número + zona) ya alcanza para avanzar a la capa 4 — no se
 * obliga a mandar el pin después, solo se avisa que es aproximada.
 *
 * Cliente nuevo (ver esClienteNuevo()): se salta el selector de
 * departamento -> `ubicacion_verificar`, que detecta el departamento a
 * partir de la ubicación (pin o texto). Si verifica, converge en
 * `confirmar_ubicacion` igual que el resto (la capa 4 aplica siempre).
 *
 * handlePedirNuevoContenedor(): cliente ocasional con contenedor que pide
 * otro — misma dirección (ya verificada antes, no se repite capa 4) u otra
 * (reusa `ubicacion_verificar`).
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

/**
 * A partir de un resultado ya OK de `verificarUbicacionCompleta`: si hubo un
 * mismatch contra el departamento elegido de antes, le pregunta al cliente
 * cuál es el correcto; si no, avanza directo a la capa 4.
 */
async function avanzarSegunResultado(
  to: string,
  sesion: Sesion,
  resultado: Extract<ResultadoVerificacionZona, { ok: true }>,
  lat: number,
  lng: number,
  direccion: string | null,
  departamentoEsperado: string | undefined,
  avisoExtra?: string,
): Promise<void> {
  if (resultado.mismatchCon && departamentoEsperado) {
    await setSesion({
      ...sesion,
      paso: 'confirmar_departamento_detectado',
      contexto: { departamento: departamentoEsperado, departamentoDetectado: resultado.mismatchCon, destinoLat: lat, destinoLng: lng, destinoDireccion: direccion },
    });
    await sendButtons(
      to,
      `📍 Notamos algo raro: cotizaste para *${departamentoEsperado}*, pero esa ubicación parece estar en *${resultado.mismatchCon}*.\n\n¿Cuál es el correcto?`,
      [
        { id: 'depto_mantener', title: departamentoEsperado.slice(0, 20) },
        { id: 'depto_cambiar', title: resultado.mismatchCon.slice(0, 20) },
      ],
    );
    return;
  }
  await avanzarAConfirmarUbicacion(to, sesion, resultado.departamento, lat, lng, direccion, avisoExtra);
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
 * Verificación de ubicación para un cliente nuevo o para "otra dirección"
 * (handlePedirNuevoContenedor): detecta el departamento a partir de la
 * ubicación, ya sea pin GPS o dirección escrita (geocodificada). Si no cae
 * en ninguna zona conocida -> caso borde "fuera de zona". Si cae en una zona
 * sin tarifa activa, se le avisa. Si todo da bien, converge en la MISMA
 * confirmación de capa 4 que el flujo normal.
 */
async function manejarUbicacionVerificar(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (m.tipo === 'location' && m.lat != null && m.lng != null) {
    const direccionCruda = m.ubicacionDireccion || m.ubicacionNombre || null;
    const resultado = await verificarUbicacionCompleta(m, sesion, m.lat, m.lng, direccionCruda, { requiereTarifa: true });
    if (!resultado.ok) return;

    const destinoDireccion = direccionCruda ?? (await reverseGeocode(m.lat, m.lng));
    await avanzarAConfirmarUbicacion(to, sesion, resultado.departamento, m.lat, m.lng, destinoDireccion);
    return;
  }

  // Dirección escrita: en vez de pedir calle + altura + localidad todo en un
  // solo mensaje (lo que geocodificaba mal o generaba candidatos ambiguos),
  // se pregunta paso a paso — este primer texto es la calle.
  if (m.tipo === 'text' && m.texto && m.texto.trim().length >= 2) {
    await sendText(to, '🛣️ ¿Y el *número* de la altura? (si no tiene, escribí "s/n")');
    await setSesion({ ...sesion, paso: 'ubicacion_verificar_numero', contexto: { calle: m.texto.trim() } });
    return;
  }

  await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso('📍 Para cotizar necesito verificar tu ubicación.'));
}

async function manejarUbicacionVerificarNumero(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'text' || !m.texto?.trim()) {
    await sendText(to, '🛣️ Necesito el número de la altura (o "s/n" si no tiene).');
    return;
  }
  const calle = sesion.contexto.calle as string;
  await sendText(to, '🚚 Última cosa: ¿alguna indicación para el chofer (portón, timbre, entre calles)? Si no hay, escribí "no".');
  await setSesion({ ...sesion, paso: 'ubicacion_verificar_indicacion', contexto: { calle, numero: m.texto.trim() } });
}

async function manejarUbicacionVerificarIndicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'text' || !m.texto) {
    await sendText(to, '🚚 Contame si hay alguna indicación para el chofer, o escribí "no".');
    return;
  }
  const { calle, numero } = sesion.contexto as { calle: string; numero: string };
  const indicacion = normalizarIndicacion(m.texto);
  const busqueda = armarDireccionBusqueda(calle, numero);
  const resultado = await buscarCandidatosDireccion(busqueda);

  if (resultado.tipo === 'sin_resultados') {
    await sendText(
      to,
      `🙁 No encontramos "${busqueda}". Probemos de nuevo — ¿cuál es el *nombre de la calle*? ` +
        'O tocá el botón de "Enviar ubicación" para mandar el pin.',
    );
    await setSesion({ ...sesion, paso: 'ubicacion_verificar', contexto: {} });
    return;
  }
  if (resultado.tipo === 'un_candidato') {
    const direccionFinal = combinarDireccionConIndicacion(resultado.candidato.direccion, indicacion);
    const r = await verificarUbicacionCompleta(m, sesion, resultado.candidato.lat, resultado.candidato.lng, direccionFinal, {
      requiereTarifa: true,
    });
    if (!r.ok) return;
    await avanzarAConfirmarUbicacion(to, sesion, r.departamento, resultado.candidato.lat, resultado.candidato.lng, direccionFinal, AVISO_DIRECCION_APROXIMADA);
    return;
  }
  await enviarListaCandidatos(to, resultado.candidatos);
  await setSesion({ ...sesion, paso: 'elegir_candidato_direccion_verificar', contexto: { candidatos: resultado.candidatos, indicacion } });
}

/** Igual que manejarEleccionCandidato, pero para cuando no hay un departamento pre-elegido (ver manejarUbicacionVerificar). */
async function manejarEleccionCandidatoVerificar(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const { candidatos = [], indicacion = null } = sesion.contexto as { candidatos: CandidatoDireccion[]; indicacion: string | null };

  const elegido = elegirCandidato(m, candidatos);
  if (!elegido) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una de las direcciones de la lista. 👆');
    return;
  }

  const direccionFinal = combinarDireccionConIndicacion(elegido.direccion, indicacion);
  const resultado = await verificarUbicacionCompleta(m, sesion, elegido.lat, elegido.lng, direccionFinal, { requiereTarifa: true });
  if (!resultado.ok) return;
  await avanzarAConfirmarUbicacion(to, sesion, resultado.departamento, elegido.lat, elegido.lng, direccionFinal, AVISO_DIRECCION_APROXIMADA);
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
    await setSesion({ telefono: to, flujo: 'cotizacion', paso: 'ubicacion_verificar', contexto: {} });
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

/** Candidatos de una dirección escrita (forwardGeocode), con un departamento ya elegido de antes -> se verifica directo y se avanza a capa 4. */
async function manejarEleccionCandidato(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const { departamento, candidatos, indicacion = null } = sesion.contexto as {
    departamento: string;
    candidatos: CandidatoDireccion[];
    indicacion: string | null;
  };

  const elegido = elegirCandidato(m, candidatos);
  if (!elegido) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una de las direcciones de la lista. 👆');
    return;
  }

  const direccionFinal = combinarDireccionConIndicacion(elegido.direccion, indicacion);
  const resultado = await verificarUbicacionCompleta(m, sesion, elegido.lat, elegido.lng, direccionFinal, {
    departamentoEsperado: departamento,
  });
  if (!resultado.ok) return;
  await avanzarSegunResultado(to, sesion, resultado, elegido.lat, elegido.lng, direccionFinal, departamento, AVISO_DIRECCION_APROXIMADA);
}

export async function handleCotizacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'ubicacion_verificar') {
    return manejarUbicacionVerificar(m, sesion);
  }
  if (sesion.paso === 'ubicacion_verificar_numero') {
    return manejarUbicacionVerificarNumero(m, sesion);
  }
  if (sesion.paso === 'ubicacion_verificar_indicacion') {
    return manejarUbicacionVerificarIndicacion(m, sesion);
  }
  if (sesion.paso === 'elegir_candidato_direccion_verificar') {
    return manejarEleccionCandidatoVerificar(m, sesion);
  }
  if (sesion.paso === 'elegir_ubicacion_nuevo') {
    return manejarEleccionUbicacionNuevo(m, sesion);
  }
  if (sesion.paso === 'elegir_candidato_direccion') {
    return manejarEleccionCandidato(m, sesion);
  }

  // Paso 0: mostrar la lista de departamentos activos — salvo que sea un
  // cliente nuevo (nunca cotizó/pagó, sin contenedor), a quien no le
  // preguntamos departamento: directamente le pedimos y verificamos la
  // ubicación (ver manejarUbicacionVerificar).
  if (!sesion.paso || sesion.paso === 'inicio') {
    if (await esClienteNuevo(to)) {
      await setSesion({ telefono: to, flujo: 'cotizacion', paso: 'ubicacion_verificar', contexto: {} });
      await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso('📍 Para cotizar necesito verificar tu ubicación.'));
      return;
    }

    const deptos = await query<{ departamento: string }>(
      'SELECT departamento FROM tarifas_departamento WHERE activo = TRUE ORDER BY departamento LIMIT 10',
    );
    if (deptos.length === 0) {
      await sendText(to, '🙁 No tenemos tarifas cargadas por el momento. Escribí *asesor* y te ayudamos igual.');
      await clearSesion(to);
      return;
    }
    await sendList(
      to,
      '🧮 Cotización de flete',
      '¡Genial! Elegí el *departamento* de destino:',
      'Ver departamentos',
      deptos.map((d) => ({ id: `depto:${d.departamento}`, title: d.departamento })),
    );
    await setSesion({ ...sesion, flujo: 'cotizacion', paso: 'elegir_departamento', contexto: {} });
    return;
  }

  // Paso 1: recibió la selección del departamento -> pedimos la ubicación de entrega.
  if (sesion.paso === 'elegir_departamento') {
    if (!m.seleccionId?.startsWith('depto:')) {
      await manejarRespuestaInvalida(m, 'Por favor, elegí una opción de la lista.\n\n_Escribí *menú* para volver al inicio._');
      return;
    }
    const departamento = m.seleccionId.replace('depto:', '');
    await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Última cosa: ¿a qué dirección de *${departamento}* llevamos el contenedor?`));
    await setSesion({ ...sesion, paso: 'ubicacion', contexto: { departamento } });
    return;
  }

  // Paso 2: recibió la ubicación (pin GPS o dirección escrita).
  if (sesion.paso === 'ubicacion') {
    const departamento = sesion.contexto.departamento as string;

    if (m.tipo === 'location' && m.lat != null && m.lng != null) {
      let destinoDireccion = m.ubicacionDireccion || m.ubicacionNombre || (sesion.contexto.destinoDireccionReferencia as string | undefined) || null;
      if (!destinoDireccion) {
        destinoDireccion = await reverseGeocode(m.lat, m.lng);
      }

      // Comparamos contra el polígono del departamento elegido (ver
      // geoDepartamento.service.ts, capas 2/3 vía ubicacionZona.helper.ts).
      // Sin este chequeo, nada impedía cotizar para un departamento y
      // compartir la ubicación de otro -> precio mal calculado, y después la
      // ruta/el aviso al chofer también mal armados.
      const resultado = await verificarUbicacionCompleta(m, sesion, m.lat, m.lng, destinoDireccion, {
        departamentoEsperado: departamento,
      });
      if (!resultado.ok) return;
      await avanzarSegunResultado(to, sesion, resultado, m.lat, m.lng, destinoDireccion, departamento);
      return;
    }

    // Dirección escrita: se pregunta paso a paso (calle, después número,
    // después indicación) en vez de pedir todo en un solo mensaje — con
    // texto libre, direcciones ambiguas o incompletas devolvían varios
    // candidatos parecidos e imposibles de distinguir en la lista.
    if (m.tipo === 'text' && m.texto && m.texto.trim().length >= 2) {
      await sendText(to, '🛣️ ¿Y el *número* de la altura? (si no tiene, escribí "s/n")');
      await setSesion({ ...sesion, paso: 'ubicacion_numero', contexto: { departamento, calle: m.texto.trim() } });
      return;
    }

    await sendText(to, mensajePedirUbicacionPasoAPaso('📍 Necesito la dirección de entrega para poder cotizar.'));
    return;
  }

  // Paso 2.1: recibió el número de la altura.
  if (sesion.paso === 'ubicacion_numero') {
    const { departamento, calle } = sesion.contexto as { departamento: string; calle: string };
    if (m.tipo !== 'text' || !m.texto?.trim()) {
      await sendText(to, '🛣️ Necesito el número de la altura (o "s/n" si no tiene).');
      return;
    }
    await sendText(to, '🚚 Última cosa: ¿alguna indicación para el chofer (portón, timbre, entre calles)? Si no hay, escribí "no".');
    await setSesion({ ...sesion, paso: 'ubicacion_indicacion', contexto: { departamento, calle, numero: m.texto.trim() } });
    return;
  }

  // Paso 2.2: recibió la indicación (o "no") -> geocodifica calle + número + departamento ya elegido.
  if (sesion.paso === 'ubicacion_indicacion') {
    const { departamento, calle, numero } = sesion.contexto as { departamento: string; calle: string; numero: string };
    if (m.tipo !== 'text' || !m.texto) {
      await sendText(to, '🚚 Contame si hay alguna indicación para el chofer, o escribí "no".');
      return;
    }
    const indicacion = normalizarIndicacion(m.texto);
    const busqueda = armarDireccionBusqueda(calle, numero, departamento);
    const resultado = await buscarCandidatosDireccion(busqueda);

    if (resultado.tipo === 'sin_resultados') {
      await sendText(
        to,
        `🙁 No encontramos "${busqueda}". Probemos de nuevo — ¿cuál es el *nombre de la calle*? ` +
          'O tocá el botón de "Enviar ubicación" para mandar el pin.',
      );
      await setSesion({ ...sesion, paso: 'ubicacion', contexto: { departamento } });
      return;
    }
    if (resultado.tipo === 'un_candidato') {
      const direccionFinal = combinarDireccionConIndicacion(resultado.candidato.direccion, indicacion);
      const r = await verificarUbicacionCompleta(m, sesion, resultado.candidato.lat, resultado.candidato.lng, direccionFinal, {
        departamentoEsperado: departamento,
      });
      if (!r.ok) return;
      await avanzarSegunResultado(to, sesion, r, resultado.candidato.lat, resultado.candidato.lng, direccionFinal, departamento, AVISO_DIRECCION_APROXIMADA);
      return;
    }
    await enviarListaCandidatos(to, resultado.candidatos);
    await setSesion({ ...sesion, paso: 'elegir_candidato_direccion', contexto: { departamento, candidatos: resultado.candidatos, indicacion } });
    return;
  }

  // Paso 2b: la dirección no caía dentro del departamento cotizado (pero sí de OTRO
  // conocido) -> el cliente decide cuál es el correcto.
  if (sesion.paso === 'confirmar_departamento_detectado') {
    const { departamento, departamentoDetectado, destinoLat, destinoLng, destinoDireccion } = sesion.contexto as {
      departamento: string;
      departamentoDetectado: string | null;
      destinoLat: number | null;
      destinoLng: number | null;
      destinoDireccion: string | null;
    };

    if (m.seleccionId === 'depto_mantener') {
      return avanzarAConfirmarUbicacion(to, sesion, departamento, destinoLat, destinoLng, destinoDireccion);
    }
    if (m.seleccionId === 'depto_cambiar' && departamentoDetectado) {
      return avanzarAConfirmarUbicacion(to, sesion, departamentoDetectado, destinoLat, destinoLng, destinoDireccion);
    }
    await manejarRespuestaInvalida(m, 'Elegí una de las opciones de arriba.\n\n_Escribí *menú* para volver al inicio._');
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
      await setSesion({ ...sesion, paso: 'ubicacion', contexto: { departamento } });
      return;
    }
    if (m.seleccionId !== 'ubicacion_es_destino') {
      await manejarRespuestaInvalida(
        m,
        'Elegí "📍 Es el destino" o "↩️ Mandar otra".\n\n_Escribí *menú* para volver al inicio._',
      );
      return;
    }

    await pedirTipoLugar(to, { ...sesion, contexto: { departamento, destinoLat, destinoLng, destinoDireccion } });
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
