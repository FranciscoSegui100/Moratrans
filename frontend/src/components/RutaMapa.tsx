import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Navigation, X, ExternalLink, RefreshCw } from 'lucide-react';

export interface ParadaMapaItem {
  id: string;
  orden: number;
  tipo: 'entrega' | 'retiro' | 'recambio' | 'vaciado';
  direccion: string | null;
  lat: number | string | null;
  lng: number | string | null;
  contenedorNumero?: string | null;
  clienteNombre?: string | null;
  clienteTelefono?: string | null;
  horario?: string | null;
  completada?: boolean;
  enCurso?: boolean;
}

interface RutaMapaProps {
  paradas: ParadaMapaItem[];
  choferNombre?: string | null;
  patente?: string | null;
  onClose?: () => void;
  altura?: string | number;
}

// Colores de alta visibilidad según el tipo de parada
const COLOR_TIPO: Record<string, string> = {
  entrega: '#10b981',   // Verde esmeralda
  retiro: '#f59e0b',    // Ámbar / Naranja
  recambio: '#8b5cf6',  // Violeta
  vaciado: '#3b82f6',   // Azul
  finalizada: '#64748b',// Gris pizarra
};

function crearIconoMarcador(orden: number, tipo: string, completada: boolean, enCurso: boolean) {
  const color = completada ? COLOR_TIPO.finalizada : COLOR_TIPO[tipo] ?? '#0284c7';
  const borde = enCurso ? '3px solid #38bdf8' : '2px solid #ffffff';
  const shadow = enCurso ? '0 0 0 4px rgba(56, 189, 248, 0.4), 0 4px 10px rgba(0,0,0,0.3)' : '0 2px 6px rgba(0,0,0,0.3)';
  const pulseClass = enCurso ? 'pulse-pin' : '';

  const html = `
    <div class="${pulseClass}" style="
      background-color: ${color};
      color: #ffffff;
      width: 32px;
      height: 32px;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      display: flex;
      align-items: center;
      justify-content: center;
      border: ${borde};
      box-shadow: ${shadow};
      cursor: pointer;
    ">
      <span style="
        transform: rotate(45deg);
        font-weight: 800;
        font-size: 13px;
        font-family: inherit;
        line-height: 1;
      ">${completada ? '✓' : orden}</span>
    </div>
  `;

  return L.divIcon({
    className: 'custom-leaflet-marker',
    html,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32],
  });
}

export function RutaMapa({
  paradas,
  choferNombre,
  patente,
  onClose,
  altura = 420,
}: RutaMapaProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);

  const [paradasConGeo, setParadasConGeo] = useState<ParadaMapaItem[]>([]);

  useEffect(() => {
    const validas = paradas.filter(
      (p) =>
        p.lat != null &&
        p.lng != null &&
        !isNaN(Number(p.lat)) &&
        !isNaN(Number(p.lng)) &&
        Number(p.lat) !== 0 &&
        Number(p.lng) !== 0
    );
    setParadasConGeo(validas);
  }, [paradas]);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Inicializar mapa si no existe
    if (!mapInstanceRef.current) {
      // Coordenadas iniciales por defecto: Gran Mendoza, Argentina
      const map = L.map(mapContainerRef.current, {
        center: [-32.8895, -68.8458],
        zoom: 12,
        zoomControl: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);

      markersLayerRef.current = L.layerGroup().addTo(map);
      mapInstanceRef.current = map;
    }

    const map = mapInstanceRef.current;
    const markersLayer = markersLayerRef.current;
    if (!map || !markersLayer) return;

    // Limpiar marcadores y polilínea anterior
    markersLayer.clearLayers();
    if (polylineRef.current) {
      map.removeLayer(polylineRef.current);
      polylineRef.current = null;
    }

    if (paradasConGeo.length === 0) return;

    const latLngs: L.LatLngExpression[] = [];

    paradasConGeo.forEach((p) => {
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      const latLng: [number, number] = [lat, lng];
      latLngs.push(latLng);

      const markerIcon = crearIconoMarcador(p.orden, p.tipo, !!p.completada, !!p.enCurso);
      const marker = L.marker(latLng, { icon: markerIcon });

      const googleMapsLink = `https://www.google.com/maps?q=${lat},${lng}`;
      const tipoLabel =
        p.tipo === 'recambio'
          ? '🔄 Recambio'
          : p.tipo === 'entrega'
          ? '📦 Entrega'
          : p.tipo === 'retiro'
          ? '📥 Retiro'
          : '♻️ Vaciado';

      const popupHtml = `
        <div style="font-family: system-ui, -apple-system, sans-serif; font-size: 13px; min-width: 200px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <strong style="font-size: 14px;">Parada #${p.orden}</strong>
            <span style="
              background: ${COLOR_TIPO[p.completada ? 'finalizada' : p.tipo] ?? '#0284c7'};
              color: white;
              padding: 2px 7px;
              border-radius: 9999px;
              font-size: 11px;
              font-weight: 700;
            ">${tipoLabel}</span>
          </div>

          ${p.enCurso ? '<div style="color: #0284c7; font-weight: 700; font-size: 11px; margin-bottom: 4px;">🚚 Chofer en camino ahora</div>' : ''}
          ${p.completada ? '<div style="color: #10b981; font-weight: 700; font-size: 11px; margin-bottom: 4px;">✓ Parada completada</div>' : ''}

          <div style="color: #1e293b; font-weight: 600; margin-bottom: 4px;">📍 ${p.direccion ?? 'Sin dirección'}</div>
          
          ${p.contenedorNumero ? `<div style="color: #475569; font-size: 12px; margin-bottom: 2px;">📦 Contenedor: <strong>${p.contenedorNumero}</strong></div>` : ''}
          ${p.clienteNombre ? `<div style="color: #475569; font-size: 12px; margin-bottom: 2px;">👤 ${p.clienteNombre}</div>` : ''}
          ${p.clienteTelefono ? `<div style="color: #475569; font-size: 12px; margin-bottom: 2px;">📞 <a href="tel:${p.clienteTelefono}">${p.clienteTelefono}</a></div>` : ''}
          ${p.horario ? `<div style="color: #64748b; font-size: 11px; margin-top: 4px;">🕐 Preferencia: ${p.horario}</div>` : ''}

          <div style="margin-top: 8px; border-top: 1px solid #e2e8f0; padding-top: 6px;">
            <a href="${googleMapsLink}" target="_blank" rel="noopener noreferrer" style="
              display: inline-flex;
              align-items: center;
              gap: 4px;
              color: #2563eb;
              text-decoration: none;
              font-weight: 600;
              font-size: 11px;
            ">
              Abrir en Google Maps ↗
            </a>
          </div>
        </div>
      `;

      marker.bindPopup(popupHtml);
      markersLayer.addLayer(marker);
    });

    // Dibujar recorrido trazado (polilínea)
    if (latLngs.length > 1) {
      polylineRef.current = L.polyline(latLngs, {
        color: '#3b82f6',
        weight: 3.5,
        opacity: 0.85,
        dashArray: '6, 8',
      }).addTo(map);
    }

    // Auto-centrar en todas las paradas
    if (latLngs.length > 0) {
      const bounds = L.latLngBounds(latLngs);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }

    // Refrescar tamaño del mapa tras renderizado
    setTimeout(() => {
      map.invalidateSize();
    }, 200);
  }, [paradasConGeo]);

  function recentrarMapa() {
    if (!mapInstanceRef.current || paradasConGeo.length === 0) return;
    const latLngs = paradasConGeo.map((p) => [Number(p.lat), Number(p.lng)] as [number, number]);
    mapInstanceRef.current.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40], maxZoom: 15 });
  }

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-sm)',
        background: 'var(--bg-surface)',
        marginBottom: '16px',
      }}
    >
      {/* Barra de cabecera del mapa */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <MapPin size={16} className="text-accent" />
          <strong style={{ fontSize: '0.85rem' }}>
            Mapa de Recorrido {choferNombre ? `· ${choferNombre}` : ''}
          </strong>
          {patente && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              ({patente})
            </span>
          )}
          <span
            style={{
              fontSize: '0.72rem',
              padding: '2px 8px',
              borderRadius: '999px',
              background: 'var(--bg-input)',
              color: 'var(--text-secondary)',
            }}
          >
            {paradasConGeo.length} de {paradas.length} paradas con GPS
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={recentrarMapa}
            title="Re-centrar mapa para ver todas las paradas"
            style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            <Navigation size={13} /> Ver todo
          </button>
          {onClose && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              title="Cerrar vista de mapa"
              style={{ padding: '4px' }}
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Contenedor del mapa Leaflet */}
      <div
        ref={mapContainerRef}
        style={{
          width: '100%',
          height: typeof altura === 'number' ? `${altura}px` : altura,
          zIndex: 1,
        }}
      />

      {/* Leyenda interactiva al pie del mapa */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px',
          background: 'var(--bg-surface)',
          borderTop: '1px solid var(--border)',
          fontSize: '0.72rem',
          color: 'var(--text-secondary)',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: COLOR_TIPO.entrega }} /> Entrega
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: COLOR_TIPO.retiro }} /> Retiro
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: COLOR_TIPO.recambio }} /> Recambio
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: COLOR_TIPO.vaciado }} /> Vaciado
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: COLOR_TIPO.finalizada }} /> Completada
          </span>
        </div>

        {paradas.length > paradasConGeo.length && (
          <span style={{ color: 'var(--warning-text, #d97706)' }}>
            ⚠️ {paradas.length - paradasConGeo.length} parada(s) sin coordenadas GPS no se muestran en el mapa.
          </span>
        )}
      </div>
    </div>
  );
}
