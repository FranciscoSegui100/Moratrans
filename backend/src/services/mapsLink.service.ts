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
    const { urlFinal, html } = await resolverUrlFinal(url);
    // Google dejó de mandar `@lat,lng` en la URL final de estos links cortos
    // (ahora redirige a `?q=<dirección en texto>&ftid=...`, sin coordenadas
    // visibles) — pero las coordenadas del lugar siguen viajando adentro del
    // HTML de esa página (mapa estático de vista previa / estado interno de
    // la app), así que si la URL no las tiene, se buscan ahí.
    return extraerCoordenadasDeUrl(urlFinal) ?? extraerCoordenadasDeHtml(html);
  } catch (err) {
    console.error('Error resolviendo link de Maps:', (err as Error).message);
    return null;
  }
}

async function resolverUrlFinal(url: string): Promise<{ urlFinal: string; html: string }> {
  const res = await axios.get(url, {
    maxRedirects: 5,
    timeout: 5000,
    validateStatus: () => true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MoraTrans-Logistica)' },
  });
  // axios (vía follow-redirects) deja la URL final resuelta acá después de seguir los 30x.
  const responseUrl = (res.request as { res?: { responseUrl?: string } })?.res?.responseUrl;
  return { urlFinal: responseUrl || url, html: typeof res.data === 'string' ? res.data : '' };
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

/**
 * Fallback cuando la URL final no trae coordenadas (formato actual de los
 * links cortos de Google Maps, ver comentario en resolverCoordenadasDeLinkMaps):
 * se buscan en el HTML de la página misma, en dos lugares donde Google las
 * sigue incrustando: el `center=lat,lng` del mapa estático de vista previa
 * (meta og:image), y el patrón `!1d<radio>!2d<lng>!3d<lat>` de un link
 * interno de la página.
 */
function extraerCoordenadasDeHtml(html: string): { lat: number; lng: number } | null {
  const centerMatch = html.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/) || html.match(/center=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (centerMatch) return { lat: Number(centerMatch[1]), lng: Number(centerMatch[2]) };

  const dataMatch = html.match(/%211d[\d.]+%212d(-?\d+\.\d+)%213d(-?\d+\.\d+)/) || html.match(/!1d[\d.]+!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
  if (dataMatch) return { lat: Number(dataMatch[2]), lng: Number(dataMatch[1]) };

  return null;
}
