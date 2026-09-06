import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { agruparVisitas, type Visita } from '../lib/viajes';
import { ViajeCard, type ViajeTablero } from './ViajeCard';

interface Chofer { id: string; nombre: string; }
type VisitaTablero = Visita<ViajeTablero>;

const iniciales = (nombre: string) => nombre.split(',')[0].trim().slice(0, 2).toUpperCase();

function statsDe(lista: VisitaTablero[]) {
  let ent = 0, ret = 0, rec = 0, warn = 0;
  for (const v of lista) {
    if (v.entrega && v.retiro) { rec++; if (!v.entrega.contenedor_numero) warn++; }
    else if (v.entrega) { ent++; if (!v.entrega.contenedor_numero) warn++; }
    else ret++;
  }
  return { ent, ret, rec, warn };
}

/**
 * Tablero de asignación: una columna "Sin asignar" + una por chofer activo.
 * Se arrastra una tarjeta a la columna de un chofer para asignarla (o se usa
 * el botón "Asignar" de la tarjeta). Asignar dispara el mismo aviso de
 * WhatsApp que el <select> de la tabla — la asignación es independiente de
 * Rutas (solo setea chofer_id).
 */
export function TableroViajes({
  viajes,
  choferes,
  puedeAsignar,
  mostrarFecha,
  onAsignar,
}: {
  viajes: ViajeTablero[];
  choferes: Chofer[];
  puedeAsignar: boolean;
  mostrarFecha: boolean;
  onAsignar: (viajeIds: string[], choferId: string | null) => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null); // 'sin' | choferId

  const visitas = agruparVisitas(viajes);
  const visitaPorKey = new Map(visitas.map((v) => [v.key, v]));

  const sinAsignar = visitas.filter((v) => !v.viajes.some((x) => x.chofer_id));
  const porChofer = new Map<string, VisitaTablero[]>(choferes.map((c) => [c.id, []]));
  for (const v of visitas) {
    const cid = v.viajes.find((x) => x.chofer_id)?.chofer_id;
    if (cid && porChofer.has(cid)) porChofer.get(cid)!.push(v);
  }

  function soltarEn(colId: string) {
    const v = dragKey ? visitaPorKey.get(dragKey) : null;
    setDragKey(null);
    setDropCol(null);
    if (!v) return;
    const choferId = colId === 'sin' ? null : colId;
    const actual = v.viajes.find((x) => x.chofer_id)?.chofer_id ?? null;
    if (actual === choferId) return;
    onAsignar(v.viajes.map((x) => x.id), choferId);
  }

  // Función que devuelve JSX (no un componente) para no re-montar las columnas
  // en cada render y perder el estado de drag.
  const renderColumna = (id: string, cabecera: React.ReactNode, lista: VisitaTablero[], esSinAsignar: boolean) => {
    const s = statsDe(lista);
    return (
      <div
        key={id}
        className={`tablero-col${esSinAsignar ? ' sin-asignar' : ''}${dropCol === id ? ' drop-activo' : ''}`}
        onDragOver={(e) => { if (dragKey) { e.preventDefault(); if (dropCol !== id) setDropCol(id); } }}
        onDragLeave={(e) => {
          // Solo limpiar si el puntero salió de la columna, no al pasar sobre un hijo.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropCol((d) => (d === id ? null : d));
        }}
        onDrop={(e) => { e.preventDefault(); soltarEn(id); }}
      >
        <div className="tablero-col-head">{cabecera}</div>
        <div className="tablero-col-stats">
          <span>{s.ent} ent · {s.ret} ret · {s.rec} rec</span>
          {s.warn > 0 && (
            <span className="tablero-col-warn">
              <AlertTriangle size={11} strokeWidth={2} /> {s.warn} sin contenedor
            </span>
          )}
        </div>
        <div className="tablero-col-body">
          {lista.length === 0 && (
            <div className="tablero-col-empty">
              {puedeAsignar ? (esSinAsignar ? 'Todo asignado 🎉' : 'Soltá una tarjeta acá') : 'Sin viajes'}
            </div>
          )}
          {lista.map((v) => (
            <ViajeCard
              key={v.key}
              visita={v}
              choferes={choferes}
              puedeAsignar={puedeAsignar}
              mostrarFecha={mostrarFecha}
              arrastrando={dragKey === v.key}
              onDragStart={() => setDragKey(v.key)}
              onDragEnd={() => { setDragKey(null); setDropCol(null); }}
              onAsignar={(choferId) => onAsignar(v.viajes.map((x) => x.id), choferId)}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="tablero">
      {renderColumna(
        'sin',
        <>
          <div className="tablero-col-tit">
            <div className="t">Sin asignar</div>
            <div className="s">Arrastrá a un chofer →</div>
          </div>
          <span className="badge programado">{sinAsignar.length}</span>
        </>,
        sinAsignar,
        true,
      )}
      {choferes.map((c) => {
        const lista = porChofer.get(c.id)!;
        return renderColumna(
          c.id,
          <>
            <div className="rc-av">{iniciales(c.nombre)}</div>
            <div className="tablero-col-tit">
              <div className="t">{c.nombre}</div>
              <div className="s">{lista.length} viaje{lista.length === 1 ? '' : 's'}</div>
            </div>
          </>,
          lista,
          false,
        );
      })}
    </div>
  );
}
