import { useState } from 'react';
import { ArrowUpFromLine, ArrowDownToLine, RefreshCw, UserPlus, X } from 'lucide-react';
import { DireccionMaps } from './DireccionMaps';
import { formatearFecha } from '../lib/fechas';
import type { Visita } from '../lib/viajes';

/** Campos que el tablero necesita de cada viaje (subconjunto de la fila de GET /api/viajes). */
export interface ViajeTablero {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  estado: string;
  zona: string | null;
  grupo_id: string | null;
  chofer_id: string | null;
  contenedor_numero: string | null;
  horario_preferido: string | null;
  destino_lat: string | null;
  destino_lng: string | null;
  origen_direccion: string | null;
  destino_final_direccion: string | null;
}

interface ChoferOpc { id: string; nombre: string; }

export function ViajeCard({
  visita,
  choferes,
  puedeAsignar,
  mostrarFecha,
  arrastrando,
  onDragStart,
  onDragEnd,
  onAsignar,
}: {
  visita: Visita<ViajeTablero>;
  choferes: ChoferOpc[];
  puedeAsignar: boolean;
  mostrarFecha: boolean;
  arrastrando: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onAsignar: (choferId: string | null) => void;
}) {
  const [menuAbierto, setMenuAbierto] = useState(false);
  const { entrega, retiro } = visita;
  const esRecambio = !!entrega && !!retiro;
  // Para la dirección "adonde va el chofer": en una entrega pura es el destino
  // final (lo del cliente); en un retiro o un recambio es el origen (también
  // lo del cliente). destino_lat/lng siempre corresponde a esa dirección.
  const principal = retiro ?? entrega!;
  const direccion = entrega && !retiro ? entrega.destino_final_direccion : principal.origen_direccion;
  const asignado = visita.viajes.some((v) => v.chofer_id);

  const tipoLabel = esRecambio ? 'Recambio' : entrega ? 'Entrega' : 'Retiro';
  const tipoClase = esRecambio ? 'recambio' : entrega ? 'entrega' : 'retiro';

  return (
    <div
      className={`vcard${arrastrando ? ' dragging' : ''}`}
      draggable={puedeAsignar}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={onDragEnd}
    >
      <div className="vcard-top">
        <div className="vcard-dir">
          <DireccionMaps
            direccion={direccion}
            lat={principal.destino_lat}
            lng={principal.destino_lng}
            fallback={principal.zona ?? 'Sin dirección'}
          />
        </div>
        <span className={`tag ${tipoClase}`}>
          {esRecambio
            ? <RefreshCw size={11} strokeWidth={2} />
            : entrega
            ? <ArrowUpFromLine size={11} strokeWidth={2} />
            : <ArrowDownToLine size={11} strokeWidth={2} />}
          {tipoLabel}
        </span>
      </div>

      <div className="vcard-sub">
        {mostrarFecha && <span>{formatearFecha(principal.fecha)}</span>}
        {principal.zona && <span>{principal.zona}</span>}
        {principal.horario_preferido && <span>🕐 {principal.horario_preferido}</span>}
      </div>

      <div className="vcard-cont">
        {esRecambio ? (
          <>
            Lleno <span className="mono">{retiro!.contenedor_numero ?? '—'}</span> → vacío{' '}
            {entrega!.contenedor_numero
              ? <span className="mono">{entrega!.contenedor_numero}</span>
              : <span className="vcard-warn">⚠ sin asignar</span>}
          </>
        ) : entrega ? (
          entrega.contenedor_numero
            ? <>Contenedor <span className="mono">{entrega.contenedor_numero}</span></>
            : <span className="vcard-warn">⚠ sin contenedor</span>
        ) : (
          <>Contenedor <span className="mono">{retiro!.contenedor_numero ?? '—'}</span></>
        )}
      </div>

      {puedeAsignar && (
        <div className="vcard-foot">
          <button className="btn btn-ghost btn-sm" onClick={() => setMenuAbierto((v) => !v)}>
            <UserPlus size={13} strokeWidth={2} /> {asignado ? 'Reasignar' : 'Asignar'}
          </button>
          {asignado && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => onAsignar(null)}
              title="Sacar de este chofer (vuelve a Sin asignar)"
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
          {menuAbierto && (
            <div className="vcard-menu">
              {choferes.length === 0 && <div className="vcard-menu-empty">No hay choferes activos</div>}
              {choferes.map((c) => (
                <button
                  key={c.id}
                  className="vcard-menu-item"
                  onClick={() => { setMenuAbierto(false); onAsignar(c.id); }}
                >
                  {c.nombre}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
