import axios from 'axios';
import { env } from '../config/env';
import { VIEWBOX_MENDOZA } from '../config/bot.config';

export interface CandidatoDireccion {
  lat: number;
  lng: number;
  direccion: string;
}

/**
 * Convierte lat/lng en una dirección legible ("Chile 1120, Godoy Cruz") para
 * cuando un cliente comparte su ubicación GPS en vivo por WhatsApp — a
 * diferencia de un pin que el usuario nombra a mano, ese caso no trae
 * ninguna dirección de texto, solo coordenadas. Usa Nominatim (OpenStreetMap):
 * es gratis y no requiere API key, a cambio de un límite de uso de 1
 * request/segundo (de sobra para el volumen de este bot). Si falla o no hay
 * datos, devuelve null y el flujo sigue sin dirección (igual que hoy).
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const { data } = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { format: 'jsonv2', lat, lon: lng, addressdetails: 1, zoom: 18, 'accept-language': 'es' },
      headers: { 'User-Agent': `MoraTrans-Logistica (${env.APP_URL})` },
      timeout: 5000,
    });
    const a = data?.address as Record<string, string> | undefined;
    if (!a) return (data?.display_name as string) ?? null;
    const calle = [a.road, a.house_number].filter(Boolean).join(' ');
    const localidad = a.suburb || a.city_district || a.city || a.town || a.village || a.county;
    const partes = [calle, localidad].filter(Boolean);
    return partes.length > 0 ? partes.join(', ') : ((data?.display_name as string) ?? null);
  } catch (err) {
    console.error('Error en reverseGeocode:', (err as Error).message);
    return null;
  }
}

/**
 * Dirección escrita por el cliente -> hasta 5 candidatos con coordenadas
 * (Nominatim, mismo proveedor gratis que reverseGeocode). Nunca se usa para
 * cerrar un pedido solo con esto — el flujo SIEMPRE pide el pin GPS después
 * (regla del dueño: "no aceptes nunca una dirección escrita como dato
 * final"), esto es solo para mostrarle candidatos y ayudarlo a ubicarse.
 *
 * `bounded: 1` restringe DE VERDAD los resultados al Gran Mendoza (viewbox):
 * con `bounded: 0` (como estaba antes) el viewbox era solo una preferencia
 * de orden, así que una calle con el mismo nombre en otra provincia podía
 * aparecer igual entre los candidatos — como esta empresa solo cubre
 * departamentos de Mendoza, no tiene sentido ofrecer nada fuera de esa zona.
 *
 * Cuando Nominatim no encuentra el número exacto, cae en el centro de la
 * calle o un punto interpolado sin avisar — se marcan esos casos y se los
 * manda al final de la lista, para priorizar los que sí matchean la altura.
 */
export async function forwardGeocode(direccion: string): Promise<CandidatoDireccion[]> {
  try {
    const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        format: 'jsonv2',
        q: direccion,
        addressdetails: 1,
        limit: 5,
        countrycodes: 'ar',
        viewbox: `${VIEWBOX_MENDOZA.minLon},${VIEWBOX_MENDOZA.maxLat},${VIEWBOX_MENDOZA.maxLon},${VIEWBOX_MENDOZA.minLat}`,
        bounded: 1,
        'accept-language': 'es',
      },
      headers: { 'User-Agent': `MoraTrans-Logistica (${env.APP_URL})` },
      timeout: 5000,
    });
    if (!Array.isArray(data)) return [];
    const candidatos = data.map((r: any) => {
      const a = r.address as Record<string, string> | undefined;
      const tieneNumero = !!a?.house_number;
      const calle = a ? [a.road, a.house_number].filter(Boolean).join(' ') : '';
      const localidad = a ? a.suburb || a.city_district || a.city || a.town || a.village || a.county : '';
      const partes = [calle, localidad].filter(Boolean);
      const direccionBase = partes.length > 0 ? partes.join(', ') : (r.display_name as string);
      return {
        lat: Number(r.lat),
        lng: Number(r.lon),
        direccion: tieneNumero ? direccionBase : `${direccionBase} (altura aproximada)`,
        tieneNumero,
      };
    });
    candidatos.sort((a, b) => Number(b.tieneNumero) - Number(a.tieneNumero));
    return candidatos.map(({ tieneNumero: _tieneNumero, ...c }) => c);
  } catch (err) {
    console.error('Error en forwardGeocode:', (err as Error).message);
    return [];
  }
}
