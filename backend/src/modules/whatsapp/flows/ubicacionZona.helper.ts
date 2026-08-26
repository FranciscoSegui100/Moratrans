import { query } from '../../../config/db';
import { sendText, sendLocationRequest } from '../graphApi';
import { detectarDepartamento, distanciaALaBaseMasCercana } from '../../../services/geoDepartamento.service';
import { obtenerOCrearCliente } from '../../../services/clientes.service';
import { extraerLinkMaps, resolverCoordenadasDeLinkMaps } from '../../../services/mapsLink.service';
import { escalarAAsesor } from './asesor.flow';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Capas 2 y 3 de la verificación de ubicación (ver cotizacion.flow.ts):
 *  - Capa 2: detecta el departamento a partir de las coordenadas GPS
 *    (point-in-polygon) — nunca se le pregunta al cliente de antemano en qué
 *    departamento está, se lo determina siempre a partir de la ubicación
 *    real, así no hay manera de que quede un pedido con un departamento
 *    "elegido" que no coincide con el punto real.
 *  - Capa 3: si el punto no cae en NINGÚN departamento conocido, nunca se
 *    inventa un precio — se registra el pedido en estado 'fuera_de_zona' y
 *    se deriva a un asesor.
 * Compartida por cotización, recambio (dirección nueva) y cuenta corriente.
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

export type ResultadoVerificacionZona =
  | { ok: true; departamento: string; tarifa: { precio: string; moneda: string } | null }
  | { ok: false };

/**
 * Corre capas 2 y 3 completas a partir de un GPS ya recibido: autodetecta el
 * departamento (point-in-polygon); si no cae en ninguno -> fuera de zona (ya
 * respondido, `ok:false`).
 * `requiereTarifa`: si el flujo necesita mostrar/cobrar un precio (cotización,
 * recambio), exige tarifa activa en la zona detectada — si no hay, avisa y
 * devuelve `ok:false` (cuenta corriente no cobra acá, así que no la exige).
 */
export async function verificarUbicacionCompleta(
  m: MensajeEntrante,
  sesion: Sesion,
  lat: number,
  lng: number,
  destinoDireccion: string | null,
  opciones: {
    requiereTarifa?: boolean;
    contextoPedidoFueraDeZona?: ContextoPedidoFueraDeZona;
  } = {},
): Promise<ResultadoVerificacionZona> {
  const to = m.from;
  const { requiereTarifa = false, contextoPedidoFueraDeZona } = opciones;

  const departamento = await detectarDepartamento(lat, lng);
  if (!departamento) {
    await manejarFueraDeZona(m, sesion, lat, lng, destinoDireccion, contextoPedidoFueraDeZona);
    return { ok: false };
  }

  if (!requiereTarifa) {
    return { ok: true, departamento, tarifa: null };
  }

  const [tarifa] = await query<{ precio: string; moneda: string }>(
    'SELECT precio, moneda FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [departamento],
  );
  if (!tarifa) {
    await sendLocationRequest(
      to,
      `🙁 Detectamos tu ubicación en *${departamento}*, pero no tenemos tarifa activa ahí todavía. Volvé a compartir tu ubicación, o escribí *asesor* para coordinarlo.`,
    );
    return { ok: false };
  }

  return { ok: true, departamento, tarifa };
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
