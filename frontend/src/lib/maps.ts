/**
 * Link a Google Maps para una dirección de cliente. Con lat/lng (llegó de una
 * ubicación GPS compartida por WhatsApp) apunta al pin exacto; si no hay
 * coordenadas, cae a una búsqueda por texto de la dirección.
 */
export function mapsUrl(
  direccion: string | null | undefined,
  lat?: string | number | null,
  lng?: string | number | null,
): string | null {
  if (lat != null && lng != null && lat !== '' && lng !== '') {
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }
  if (direccion) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(direccion)}`;
  return null;
}
