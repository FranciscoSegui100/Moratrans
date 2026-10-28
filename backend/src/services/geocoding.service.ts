import axios from 'axios';
import { env } from '../config/env';

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
 * Dirección a guardar para un pin de WhatsApp: la que trae el propio pin, o
 * la de Nominatim, o — si Nominatim no contestó (timeout, límite de uso) —
 * las coordenadas tal cual. Antes ese último caso guardaba NULL y el chofer
 * recibía "Sin dirección registrada" aunque el viaje tenía el punto exacto;
 * con las coordenadas como texto el link de Google Maps del aviso lo abre
 * igual (ver avisarChoferViaje).
 */
export async function direccionDeUbicacion(lat: number, lng: number, direccionCruda: string | null | undefined): Promise<string> {
  if (direccionCruda) return direccionCruda;
  return (await reverseGeocode(lat, lng)) ?? `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}
