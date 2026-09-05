import { X, AlertTriangle } from 'lucide-react';
import { DireccionMaps } from './DireccionMaps';
import { formatearFecha } from '../lib/fechas';

interface ViajePendiente {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  zona: string | null;
  contenedor_numero: string | null;
  destino_direccion: string | null;
  destino_lat: string | null;
  destino_lng: string | null;
  horario_preferido: string | null;
  hora_estimada: string | null;
  cliente_telefono: string | null;
  grupo_id: string | null;
  cliente_nombre?: string | null;
  notas?: string | null;
  remito?: string | null;
  importe?: string | null;
  es_cuenta_corriente?: boolean;
  ubicacion_direccion?: string | null;
  direccion_verificada?: boolean;
  creado_en?: string;
}
interface VisitaPendiente {
  id: string;
  fecha: string;
  zona: string | null;
  destino_direccion: string | null;
  destino_lat: string | null;
  destino_lng: string | null;
  horario_preferido: string | null;
  cliente_telefono: string | null;
  entrega?: ViajePendiente;
  retiro?: ViajePendiente;
}
interface Chofer { id: string; nombre: string; }

function Fila({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pd-row">
      <div className="pd-label">{label}</div>
      <div className="pd-value">{children}</div>
    </div>
  );
}

/** Ficha completa de un pedido de la bolsa — se abre al tocar la tarjeta. */
export function PedidoDetalleModal({
  visita,
  choferes,
  esperaLabel,
  onAsignar,
  onClose,
}: {
  visita: VisitaPendiente;
  choferes: Chofer[];
  esperaLabel: string;
  onAsignar: (choferId: string) => void;
  onClose: () => void;
}) {
  const { entrega, retiro } = visita;
  const base = entrega ?? retiro!;
  const esRecambio = !!entrega && !!retiro;
  const tipoLabel = esRecambio ? 'Recambio' : entrega ? 'Entrega' : 'Retiro';
  const tipoClase = esRecambio ? 'recambio' : entrega ? 'entrega' : 'retiro';

  const direccion = visita.destino_direccion ?? base.destino_direccion;
  const lat = visita.destino_lat ?? base.destino_lat;
  const lng = visita.destino_lng ?? base.destino_lng;
  const sinVerificar = base.direccion_verificada === false;
  const horario = visita.horario_preferido ?? base.horario_preferido;
  const horaEstimada = (base.hora_estimada ?? '').slice(0, 5);
  const importe = base.importe != null && base.importe !== '' ? Number(base.importe) : null;
  const notas = [entrega?.notas, retiro?.notas].filter((n): n is string => !!n);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="section-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={`tag ${tipoClase}`}>{tipoLabel}</span>
            <span>Pedido · {formatearFecha(visita.fecha)}</span>
          </div>
          <button className="modal-close" onClick={onClose}><X size={18} strokeWidth={2} /></button>
        </div>

        <div className="pd-grid">
          <Fila label="Cliente">
            {base.cliente_nombre ?? <span className="text-muted">Sin nombre</span>}
            {visita.cliente_telefono && <span className="text-muted"> · 📞 {visita.cliente_telefono}</span>}
          </Fila>

          <Fila label={entrega && !retiro ? 'Dirección de entrega' : 'Dirección del cliente'}>
            <DireccionMaps direccion={direccion} lat={lat} lng={lng} />
            {sinVerificar && (
              <div className="text-muted" style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                <AlertTriangle size={12} strokeWidth={2} /> Cargada a mano, sin verificar en el mapa
              </div>
            )}
          </Fila>

          <Fila label="Zona">{visita.zona ?? <span className="text-muted">—</span>}</Fila>

          <Fila label="Fecha / espera">
            {formatearFecha(visita.fecha)} <span className="text-muted">· {esperaLabel}</span>
          </Fila>

          <Fila label="Horario">
            {horario ? <>🕐 {horario} <span className="text-muted">(pidió el cliente)</span></> : <span className="text-muted">Sin preferencia</span>}
            {horaEstimada && <div>Estimado por el operador: <strong>{horaEstimada} hs</strong></div>}
          </Fila>

          {esRecambio ? (
            <>
              <Fila label="Lleno a retirar">
                {retiro!.contenedor_numero
                  ? <span className="mono">{retiro!.contenedor_numero}</span>
                  : <span className="text-muted">—</span>}
              </Fila>
              <Fila label="Vacío a dejar">
                {entrega!.contenedor_numero
                  ? <span className="mono">{entrega!.contenedor_numero}</span>
                  : <span className="text-muted">Se asigna al armar la ruta</span>}
              </Fila>
            </>
          ) : (
            <Fila label={entrega ? 'Contenedor a entregar' : 'Contenedor a retirar'}>
              {base.contenedor_numero
                ? <span className="mono">{base.contenedor_numero}</span>
                : <span className="text-muted">{entrega ? 'Se asigna al armar la ruta' : '—'}</span>}
            </Fila>
          )}

          <Fila label="Importe">
            {importe != null
              ? <strong>${importe.toLocaleString('es-AR')}</strong>
              : <span className="text-muted">—</span>}
            {base.es_cuenta_corriente && <span className="badge pendiente" style={{ marginLeft: '8px' }}>📋 Cuenta corriente</span>}
          </Fila>

          <Fila label="Nº remito">
            {base.remito ? <span className="mono">{base.remito}</span> : <span className="text-muted">—</span>}
          </Fila>

          {entrega?.ubicacion_direccion && (
            <Fila label="Sale del depósito">{entrega.ubicacion_direccion}</Fila>
          )}
          {retiro?.ubicacion_direccion && (
            <Fila label="Se descarga en">{retiro.ubicacion_direccion}</Fila>
          )}

          {notas.length > 0 && (
            <Fila label="Notas">{notas.map((n, i) => <div key={i}>{n}</div>)}</Fila>
          )}

          {esRecambio && (
            <Fila label="Planificación">
              <span className="text-muted">El recambio no se replanifica (el lleno ya está en lo del cliente): solo se rutea.</span>
            </Fila>
          )}
        </div>

        <div className="modal-footer" style={{ borderTop: '1px solid var(--border)', paddingTop: '14px', marginTop: '6px' }}>
          <div className="section-title" style={{ marginBottom: '8px' }}>Asignar a un chofer</div>
          {choferes.length === 0 ? (
            <span className="text-muted">No hay choferes activos.</span>
          ) : (
            <div className="pd-choferes">
              {choferes.map((c) => (
                <button key={c.id} className="btn btn-ghost btn-sm" onClick={() => onAsignar(c.id)}>
                  {c.nombre}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
