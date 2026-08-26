import axios from 'axios';

const REGEX_LINK_MAPS = /https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)\S*/i;

// Gran Mendoza: los 6 departamentos que cubre la empresa (ver seed.sql).
const VIEWBOX_MENDOZA = { minLon: -69.3, minLat: -33.3, maxLon: -68.4, maxLat: -32.4 };

export interface CoordenadasLinkMaps {
  lat: number;
  lng: number;
  /** Dirección encontrada al geocodificar (null si vino directo de coordenadas en la URL, sin pasar por búsqueda de texto). */
  direccion: string | null;
}

/** Busca un link de Google Maps dentro de un texto libre (puede venir con otras palabras alrededor, ej. copiado desde el botón "Compartir" de la app). */
export function extraerLinkMaps(texto: string): string | null {
  const match = texto.match(REGEX_LINK_MAPS);
  return match ? match[0] : null;
}

/**
 * Coordenadas de un link de Google Maps. Dos caminos:
 *  1. Si la URL final trae `@lat,lng` o `!3d<lat>!4d<lng>` (links largos,
 *     copiados de la barra de direcciones), se usan directo.
 *  2. Si no (formato actual de los links cortos del botón "Compartir":
 *     redirigen a `?q=<dirección en texto>&ftid=...`, sin coordenadas
 *     visibles — y las coordenadas que sí aparecen en el HTML de esa
 *     página son un relleno genérico fijo, NO el lugar real, confirmado
 *     probando dos direcciones distintas y viendo el mismo valor las dos
 *     veces), se geocodifica el texto de la dirección con Nominatim,
 *     acotado al Gran Mendoza.
 * La dirección encontrada se devuelve junto con las coordenadas para que el
 * flujo se la muestre al cliente en la confirmación ("¿es este el
 * destino?") — geocodificar texto puede fallar con calles repetidas en más
 * de un departamento, así que esa confirmación es la red de seguridad.
 */
export async function resolverCoordenadasDeLinkMaps(url: string): Promise<CoordenadasLinkMaps | null> {
  try {
    const urlFinal = await resolverUrlFinal(url);
    const coordsDeUrl = extraerCoordenadasDeUrl(urlFinal);
    if (coordsDeUrl) return { ...coordsDeUrl, direccion: null };

    const direccion = extraerDireccionDeUrl(urlFinal);
    if (!direccion) return null;
    return await geocodificarDireccion(direccion);
  } catch (err) {
    console.error('Error resolviendo link de Maps:', (err as Error).message);
    return null;
  }
}

async function resolverUrlFinal(url: string): Promise<string> {
  const res = await axios.get(url, {
    maxRedirects: 5,
    timeout: 5000,
    validateStatus: () => true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MoraTrans-Logistica)' },
  });
  // axios (vía follow-redirects) deja la URL final resuelta acá después de seguir los 30x.
  const responseUrl = (res.request as { res?: { responseUrl?: string } })?.res?.responseUrl;
  return responseUrl || url;
}

/**
 * `!3d<lat>!4d<lng>` es la coordenada del lugar/pin marcado — más precisa
 * que `@lat,lng` (que suele ser el centro del mapa, no necesariamente el
 * punto exacto). Se prueba primero esa, y se cae a los otros formatos si no
 * está.
 */
function extraerCoordenadasDeUrl(url: string): { lat: number; lng: number } | null {
  const dataMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dataMatch) return { lat: Number(dataMatch[1]), lng: Number(dataMatch[2]) };

  const arrobaMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (arrobaMatch) return { lat: Number(arrobaMatch[1]), lng: Number(arrobaMatch[2]) };

  const qMatch = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { lat: Number(qMatch[1]), lng: Number(qMatch[2]) };

  const llMatch = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (llMatch) return { lat: Number(llMatch[1]), lng: Number(llMatch[2]) };

  return null;
}

/** El `q=` de la URL final trae la dirección en texto cuando no trae coordenadas (ver resolverCoordenadasDeLinkMaps). */
function extraerDireccionDeUrl(url: string): string | null {
  const qMatch = url.match(/[?&]q=([^&]+)/);
  if (!qMatch) return null;
  const direccion = decodeURIComponent(qMatch[1].replace(/\+/g, ' ')).trim();
  return /^-?\d+\.\d+,-?\d+\.\d+$/.test(direccion) ? null : direccion || null;
}

/** Colapsa palabras repetidas seguidas (ej. "M5500HFN M5500HFN" -> "M5500HFN"), que Nominatim no tolera bien. */
function colapsarPalabrasRepetidas(texto: string): string {
  return texto.replace(/\b(\S+)(\s+\1\b)+/gi, '$1');
}

/**
 * Geocodifica el texto de dirección que trae el link. Google suele
 * anteponer el nombre del comercio/lugar antes de la calle real (ej.
 * "Clark 246 Store, J. y M. Clark 246, ..."), lo que confunde la búsqueda
 * de texto completo de Nominatim — si la búsqueda completa no encuentra
 * nada, se reintenta sacando el primer segmento (separado por coma).
 *
 * Nominatim (OpenStreetMap) no tiene cargada la altura exacta de todas las
 * calles — cuando no la tiene, el resultado cae al centro de la calle sin
 * avisar. Si pasa eso, se conserva igual la calle+altura tal como la mandó
 * Google (que sí la tiene, aunque el mapa gratuito no pueda ubicarla con
 * precisión) y se lo marca explícitamente, para que quede claro en la
 * confirmación "¿es este el destino?" que conviene revisar bien el pin.
 */
async function geocodificarDireccion(direccionCruda: string): Promise<CoordenadasLinkMaps | null> {
  const segmentos = direccionCruda
    .split(',')
    .map((s) => colapsarPalabrasRepetidas(s.trim()))
    .filter(Boolean);
  // Dedup: si dos segmentos son iguales (case-insensitive), se deja uno solo.
  const segmentosUnicos = segmentos.filter((s, i) => segmentos.findIndex((s2) => s2.toLowerCase() === s.toLowerCase()) === i);

  const intentos = [segmentosUnicos.join(', ')];
  if (segmentosUnicos.length > 2) intentos.push(segmentosUnicos.slice(1).join(', '));

  for (const intento of intentos) {
    const resultado = await buscarEnNominatim(intento);
    if (!resultado) continue;
    if (!resultado.tieneNumero) {
      const calleConNumero = segmentosUnicos.find((s) => /\d/.test(s)) ?? intento;
      resultado.direccion = `${calleConNumero} (altura aproximada — revisá bien el pin abajo)`;
    }
    return resultado;
  }
  return null;
}

async function buscarEnNominatim(direccion: string): Promise<(CoordenadasLinkMaps & { tieneNumero: boolean }) | null> {
  const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: {
      format: 'jsonv2',
      q: direccion,
      addressdetails: 1,
      limit: 1,
      countrycodes: 'ar',
      viewbox: `${VIEWBOX_MENDOZA.minLon},${VIEWBOX_MENDOZA.maxLat},${VIEWBOX_MENDOZA.maxLon},${VIEWBOX_MENDOZA.minLat}`,
      bounded: 1,
      'accept-language': 'es',
    },
    headers: { 'User-Agent': 'MoraTrans-Logistica' },
    timeout: 5000,
  });
  if (!Array.isArray(data) || data.length === 0) return null;
  const r = data[0];
  const a = r.address as Record<string, string> | undefined;
  const tieneNumero = !!a?.house_number;
  const calle = a ? [a.road, a.house_number].filter(Boolean).join(' ') : '';
  const localidad = a ? a.suburb || a.city_district || a.city || a.town || a.village || a.county : '';
  const partes = [calle, localidad].filter(Boolean);
  return {
    lat: Number(r.lat),
    lng: Number(r.lon),
    direccion: partes.length > 0 ? partes.join(', ') : (r.display_name as string),
    tieneNumero,
  };
}
