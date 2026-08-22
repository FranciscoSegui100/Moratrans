import { ReactNode } from 'react';
import { mapsUrl } from '../lib/maps';

/** Dirección con 📍 que linkea a Google Maps (pin exacto si hay lat/lng, si no busca por texto). */
export function DireccionMaps({
  direccion,
  lat,
  lng,
  fallback = '—',
}: {
  direccion: string | null | undefined;
  lat?: string | number | null | undefined;
  lng?: string | number | null | undefined;
  fallback?: ReactNode;
}) {
  const url = mapsUrl(direccion, lat, lng);
  if (!direccion) return <span className="text-muted">{fallback}</span>;
  if (!url) return <>{direccion}</>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      📍 {direccion}
    </a>
  );
}
