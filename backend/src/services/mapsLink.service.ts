import axios from 'axios';

const REGEX_LINK_MAPS = /https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)\S*/i;

/** Busca un link de Google Maps dentro de un texto libre (puede venir con otras palabras alrededor, ej. copiado desde el botón "Compartir" de la app). */
export function extraerLinkMaps(texto: string): string | null {
  const match = texto.match(REGEX_LINK_MAPS);
  return match ? match[0] : null;
}

/**
 * Coordenadas embebidas en una URL de Google Maps. Los links "cortos"
 * (maps.app.goo.gl, goo.gl/maps — lo que genera el botón "Compartir" de la
 * app) no traen coordenadas visibles en el texto del link; hay que seguir la
 * redirección HTTP hasta la URL larga real, que sí las tiene.
 */
export async function resolverCoordenadasDeLinkMaps(url: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const urlFinal = await resolverUrlFinal(url);
    return extraerCoordenadasDeUrl(urlFinal);
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
