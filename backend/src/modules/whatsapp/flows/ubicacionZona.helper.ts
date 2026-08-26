import { query } from '../../../config/db';
import { sendText, sendLocationRequest, sendList, sendButtons } from '../graphApi';
import { detectarDepartamento, distanciaALaBaseMasCercana } from '../../../services/geoDepartamento.service';
import { obtenerOCrearCliente } from '../../../services/clientes.service';
import { extraerLinkMaps, resolverCoordenadasDeLinkMaps } from '../../../services/mapsLink.service';
import { escalarAAsesor } from './asesor.flow';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Verificación de ubicación compartida por cotización, recambio (dirección
 * nueva) y cuenta corriente — cada flujo pregunta el departamento primero
 * (ver pedirDepartamento) y después pin o texto (ver pedirMetodoUbicacion):
 *  - Capa 2: si viene un pin, se detecta el departamento real a partir de
 *    las coordenadas GPS (point-in-polygon) y se compara contra el elegido
 *    (ver verificarUbicacionConDepartamentoElegido) — si no coincide, no se
 *    resuelve solo: se le pregunta al cliente cuál vale (ver
 *    preguntarMismatchDepartamento), así nunca queda un pedido con un
 *    departamento "elegido" que gane por sobre la geometría real sin que el
 *    cliente lo haya decidido explícitamente.
 *  - Capa 3: si el punto no cae en NINGÚN departamento conocido, nunca se
 *    inventa un precio — se registra el pedido en estado 'fuera_de_zona' y
 *    se deriva a un asesor.
 * Si en cambio el cliente escribe calle y número a mano, no se busca en el
 * mapa ni se puede validar contra el departamento elegido — se guarda tal
 * cual, marcada `direccion_verificada = false` para que un asesor la
 * confirme (ver mensajePedirCalleNumero y alerta 'direccion_sin_verificar'
 * en cada flujo).
 * La capa 4 (confirmación explícita "¿es el destino?") queda a criterio de
 * cada flujo — acá no se manda ningún mensaje de confirmación.
 */

export interface ContextoPedidoFueraDeZona {
  tipo?: 'entrega' | 'recambio';
  contenedorRecambioNumero?: string | null;
}

/** Capa 3 en crudo: registra el pedido 'fuera_de_zona' y escala a un asesor. */
export async function manejarFueraDeZona(
  m: MensajeEntrante,
  sesion: Sesion,
  destinoLat: number,
  destinoLng: number,
  destinoDireccion: string | null,
  contextoPedido: ContextoPedidoFueraDeZona = {},
): Promise<void> {
  const to = m.from;
  const { tipo = 'entrega', contenedorRecambioNumero = null } = contextoPedido;
  const distancia = await distanciaALaBaseMasCercana(destinoLat, destinoLng);

  const [pedido] = await query<{ numero_pedido: number }>(
    `INSERT INTO pedidos (cliente_telefono, cliente_nombre, zona, estado, destino_lat, destino_lng, destino_direccion, tipo, contenedor_recambio_numero)
     VALUES ($1,$2,$3,'fuera_de_zona',$4,$5,$6,$7,$8) RETURNING numero_pedido`,
    [to, m.nombrePerfil ?? null, 'sin_zona', destinoLat, destinoLng, destinoDireccion, tipo, contenedorRecambioNumero],
  );
  obtenerOCrearCliente(to, m.nombrePerfil).catch((e) => console.error('Error dando de alta al cliente:', e));

  await sendText(
    to,
    `📍 Tu ubicación está fuera de las zonas que cubrimos hoy` +
      (distancia ? ` (a unos *${distancia.distanciaKm} km* de ${distancia.nombre}).` : '.') +
      `\n\nAnotamos tu pedido *#${pedido.numero_pedido}* — un asesor lo va a revisar para ver si podemos coordinarlo igual.`,
  );
  await escalarAAsesor(to, sesion, `${to} pidió un contenedor fuera de zona (pedido #${pedido.numero_pedido})`);
}

/**
 * Mensaje estándar para pedir la ubicación de entrega: siempre a través de
 * una ubicación real, nunca escribiendo la dirección como texto en el chat.
 * Dos caminos posibles, ambos terminan en un pin real (lat/lng):
 *  1. El botón nativo "Enviar ubicación" de WhatsApp, que además de mandar
 *     la ubicación actual tiene un buscador adentro (lupa) para tipear la
 *     calle y ajustar el pin a mano.
 *  2. Buscar la dirección en la app de Google Maps (suele ser más precisa
 *     que el buscador de WhatsApp) y pegar acá el link que da su botón
 *     "Compartir" — el bot lo entiende igual que si hubiera mandado el pin
 *     (ver mapsLink.service.ts / resolverUbicacionMensaje).
 */
export function mensajePedirUbicacionPasoAPaso(pregunta: string): string {
  return (
    `${pregunta}\n\n` +
    `Tocá el botón *"Enviar ubicación"* de abajo 👇 — ahí podés mandar tu ubicación actual, o tocar la 🔍 lupa para buscar tu calle en el mapa.\n\n` +
    `_Tip: si el buscador de WhatsApp no te da la dirección exacta, buscala en la app de Google Maps y pegá acá el link que te da su botón "Compartir" — lo entiendo igual._`
  );
}

export type ResultadoUbicacionMensaje =
  | { tipo: 'ubicacion'; lat: number; lng: number; direccionCruda: string | null }
  | { tipo: 'link_invalido' }
  | { tipo: 'nada' };

/**
 * Extrae una ubicación real de un mensaje entrante: un pin nativo de
 * WhatsApp (`location`), o un link de Google Maps pegado como texto (ver
 * mensajePedirUbicacionPasoAPaso) — nunca se acepta una dirección escrita a
 * mano sin geolocalizar, ver comentario al principio del archivo.
 */
export async function resolverUbicacionMensaje(m: MensajeEntrante): Promise<ResultadoUbicacionMensaje> {
  if (m.tipo === 'location' && m.lat != null && m.lng != null) {
    return { tipo: 'ubicacion', lat: m.lat, lng: m.lng, direccionCruda: m.ubicacionDireccion || m.ubicacionNombre || null };
  }
  if (m.tipo === 'text' && m.texto) {
    const link = extraerLinkMaps(m.texto);
    if (link) {
      const coords = await resolverCoordenadasDeLinkMaps(link);
      if (coords) return { tipo: 'ubicacion', lat: coords.lat, lng: coords.lng, direccionCruda: coords.direccion };
      return { tipo: 'link_invalido' };
    }
  }
  return { tipo: 'nada' };
}

/** Departamentos con tarifa activa, para el selector inicial (ver pedirDepartamento). */
export async function obtenerDepartamentosActivos(): Promise<string[]> {
  const filas = await query<{ departamento: string }>(
    'SELECT departamento FROM tarifas_departamento WHERE activo = TRUE ORDER BY departamento LIMIT 10',
  );
  return filas.map((f) => f.departamento);
}

/**
 * Primer paso de los 3 flujos (Cotizar, Pedir contenedor, Recambio): elegir
 * el departamento de destino. El pin GPS sigue siendo la fuente de verdad
 * (ver verificarUbicacionConDepartamentoElegido) — esto solo da contexto
 * para poder ofrecer la opción de escribir la dirección a mano sin buscarla
 * en el mapa (ver mensajePedirCalleNumero). `false` si no hay tarifas
 * cargadas (ya le avisó al cliente).
 */
export async function pedirDepartamento(to: string, pregunta: string): Promise<boolean> {
  const departamentos = await obtenerDepartamentosActivos();
  if (departamentos.length === 0) {
    await sendText(to, '🙁 No tenemos tarifas cargadas por el momento. Escribí *asesor* y te ayudamos igual.');
    return false;
  }
  await sendList(to, '🧮 Departamento', pregunta, 'Ver departamentos', departamentos.map((d) => ({ id: `depto:${d}`, title: d })));
  return true;
}

/** Departamento elegido de la lista de pedirDepartamento, o null si la selección no viene de ahí. */
export function departamentoElegido(m: MensajeEntrante): string | null {
  return m.seleccionId?.startsWith('depto:') ? m.seleccionId.replace('depto:', '') : null;
}

const BOTONES_METODO_UBICACION = [
  { id: 'metodo_pin', title: '📍 Enviar ubicación' },
  { id: 'metodo_texto', title: '✍️ Escribir dirección' },
];

/** Segundo paso: cómo dar la dirección de ese departamento — pin (prioritario, más preciso) o escribirla a mano (ver mensajePedirCalleNumero). */
export async function pedirMetodoUbicacion(to: string, departamento: string): Promise<void> {
  await sendButtons(
    to,
    `📍 ¿Cómo nos pasás la dirección en *${departamento}*?\n\n` +
      `_El pin es mucho más preciso — lo recomendamos. Si preferís, también podés escribirla directamente._`,
    BOTONES_METODO_UBICACION,
  );
}

/** Al elegir "escribir dirección": se guarda tal cual la escribe el cliente, sin buscarla en el mapa. */
export function mensajePedirCalleNumero(departamento: string): string {
  return (
    `✍️ *ESCRIBÍ CALLE Y NÚMERO DEL DEPARTAMENTO ${departamento.toUpperCase()}*\n\n` +
    `_Ojo: esta dirección no se busca en el mapa — una persona del equipo la va a confirmar con vos antes de despachar el contenedor._`
  );
}

export type ResultadoUbicacionConDepartamento =
  | { ok: true; coincide: true; departamento: string; tarifa: { precio: string; moneda: string } | null }
  | { ok: true; coincide: false; departamentoElegido: string; departamentoDetectado: string }
  | { ok: false };

/**
 * Como verificarUbicacionCompleta, pero comparando el pin contra un
 * departamento ya elegido por el cliente (ver pedirDepartamento): si no
 * coincide, no se resuelve solo ni se descarta la geometría real — se
 * devuelve `coincide: false` para que el flujo le pregunte al cliente cuál
 * de los dos es el correcto (ver preguntarMismatchDepartamento), sin
 * mostrar precios en esa pregunta para no influenciar la respuesta.
 */
export async function verificarUbicacionConDepartamentoElegido(
  m: MensajeEntrante,
  sesion: Sesion,
  lat: number,
  lng: number,
  destinoDireccion: string | null,
  departamentoElegidoPorCliente: string,
  opciones: {
    requiereTarifa?: boolean;
    contextoPedidoFueraDeZona?: ContextoPedidoFueraDeZona;
  } = {},
): Promise<ResultadoUbicacionConDepartamento> {
  const to = m.from;
  const { requiereTarifa = false, contextoPedidoFueraDeZona } = opciones;

  const departamentoDetectado = await detectarDepartamento(lat, lng);
  if (!departamentoDetectado) {
    await manejarFueraDeZona(m, sesion, lat, lng, destinoDireccion, contextoPedidoFueraDeZona);
    return { ok: false };
  }

  if (departamentoDetectado !== departamentoElegidoPorCliente) {
    return { ok: true, coincide: false, departamentoElegido: departamentoElegidoPorCliente, departamentoDetectado };
  }

  if (!requiereTarifa) {
    return { ok: true, coincide: true, departamento: departamentoDetectado, tarifa: null };
  }

  const [tarifa] = await query<{ precio: string; moneda: string }>(
    'SELECT precio, moneda FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [departamentoDetectado],
  );
  if (!tarifa) {
    await sendLocationRequest(
      to,
      `🙁 Detectamos tu ubicación en *${departamentoDetectado}*, pero no tenemos tarifa activa ahí todavía. Volvé a compartir tu ubicación, o escribí *asesor* para coordinarlo.`,
    );
    return { ok: false };
  }

  return { ok: true, coincide: true, departamento: departamentoDetectado, tarifa };
}

/** Mensaje + botones cuando el pin no coincide con el departamento elegido — sin mostrar precios (ver verificarUbicacionConDepartamentoElegido). */
export async function preguntarMismatchDepartamento(to: string, departamentoElegidoPorCliente: string, departamentoDetectado: string): Promise<void> {
  await sendButtons(
    to,
    `📍 Tu ubicación cayó en *${departamentoDetectado}*, no en *${departamentoElegidoPorCliente}* que habías elegido.\n\n` +
      `¿Querés cambiar la cotización a *${departamentoDetectado}*, o volver a mandar la ubicación de *${departamentoElegidoPorCliente}*?`,
    [
      { id: 'depto_cambiar', title: `✅ ${departamentoDetectado}`.slice(0, 20) },
      { id: 'depto_reenviar', title: '↩️ Reenviar ubic.' },
    ],
  );
}

/** Combina la dirección geocodificada con la indicación libre para el chofer (si el cliente dio una). */
export function combinarDireccionConIndicacion(direccion: string | null, indicacion: string | null): string | null {
  if (!direccion) return indicacion;
  return indicacion ? `${direccion} — Indicación para el chofer: ${indicacion}` : direccion;
}

const RESPUESTAS_SIN_INDICACION = ['no', 'no hay', 'ninguna', 'ningun', 'nada', 'na', '-'];

/** null si el cliente contestó algo equivalente a "no tengo ninguna indicación". */
export function normalizarIndicacion(texto: string): string | null {
  const t = texto.trim();
  if (!t || RESPUESTAS_SIN_INDICACION.includes(t.toLowerCase())) return null;
  return t;
}
