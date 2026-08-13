import { useState } from 'react';
import { Check } from 'lucide-react';

export interface ValidarPagoPayload {
  diasDemora?: number;
  choferId?: string;
  venceEn?: string;
  contenedorNumero?: string;
  fechaEntrega?: string;
}

interface ContenedorOpcion { numero: string; estado: string; vence_en: string | null; }

interface Props {
  choferes: { id: string; nombre: string }[];
  contenedores: ContenedorOpcion[];
  procesando: boolean;
  onConfirm: (payload: ValidarPagoPayload) => void;
  onCancel: () => void;
}

/** Formulario que aparece al validar un pago: contenedor, chofer, días y vencimiento. */
export function ValidarPagoForm({ choferes, contenedores, procesando, onConfirm, onCancel }: Props) {
  const [contenedorNumero, setContenedorNumero] = useState('');
  const [choferId, setChoferId] = useState('');
  const [dias, setDias] = useState('');
  const [venceEn, setVenceEn] = useState('');
  const [fechaEntrega, setFechaEntrega] = useState('');

  const contenedorElegido = contenedores.find((c) => c.numero === contenedorNumero);
  // Si el contenedor elegido está ocupado, hay que decir para cuándo se
  // arma la entrega — el calendario no deja elegir antes de que vuelva.
  const ocupado = !!contenedorElegido && contenedorElegido.estado !== 'disponible';
  const minFechaEntrega = ocupado && contenedorElegido?.vence_en
    ? new Date(contenedorElegido.vence_en).toISOString().slice(0, 10)
    : undefined;

  function etiquetaContenedor(c: ContenedorOpcion): { texto: string; disabled: boolean } {
    if (c.estado === 'disponible') return { texto: c.numero, disabled: false };
    if (!c.vence_en) return { texto: `${c.numero} — ${c.estado}, sin fecha de vuelta cargada`, disabled: true };
    return { texto: `${c.numero} — vuelve el ${new Date(c.vence_en).toLocaleDateString('es-AR')}`, disabled: false };
  }

  return (
    <div className="validar-form">
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Contenedor</label>
          <select
            className="form-select"
            value={contenedorNumero}
            onChange={(e) => {
              const numero = e.target.value;
              const c = contenedores.find((x) => x.numero === numero);
              const nuevoMin = c && c.estado !== 'disponible' && c.vence_en ? new Date(c.vence_en).toISOString().slice(0, 10) : undefined;
              setContenedorNumero(numero);
              setFechaEntrega((f) => (nuevoMin && f < nuevoMin ? nuevoMin : f));
            }}
          >
            <option value="">— Automático (el primero disponible) —</option>
            {contenedores.map((c) => {
              const { texto, disabled } = etiquetaContenedor(c);
              return <option key={c.numero} value={c.numero} disabled={disabled}>{texto}</option>;
            })}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Chofer asignado</label>
          <select className="form-select" value={choferId} onChange={(e) => setChoferId(e.target.value)}>
            <option value="">— Sin asignar —</option>
            {choferes.map((c) => (
              <option key={c.id} value={c.id}>{c.nombre}</option>
            ))}
          </select>
        </div>
        {ocupado && (
          <div className="form-group">
            <label className="form-label">Fecha de entrega</label>
            <input
              className="form-input"
              type="date"
              min={minFechaEntrega}
              value={fechaEntrega}
              onChange={(e) => setFechaEntrega(e.target.value)}
              required
            />
            {minFechaEntrega && (
              <small className="text-muted">Contenedor ocupado: recién se puede elegir desde el {new Date(minFechaEntrega).toLocaleDateString('es-AR')}</small>
            )}
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Días para el retiro</label>
          <input
            className="form-input"
            type="number"
            min="0"
            placeholder="Ej. 3"
            value={dias}
            onChange={(e) => setDias(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Vencimiento del contenedor</label>
          <input className="form-input" type="date" value={venceEn} onChange={(e) => setVenceEn(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          className="btn btn-success btn-sm"
          disabled={procesando || (ocupado && !fechaEntrega)}
          onClick={() =>
            onConfirm({
              diasDemora: dias !== '' ? Number(dias) : undefined,
              choferId: choferId || undefined,
              venceEn: venceEn || undefined,
              contenedorNumero: contenedorNumero || undefined,
              fechaEntrega: ocupado ? fechaEntrega : undefined,
            })
          }
        >
          {procesando ? '...' : <><Check strokeWidth={2} /> Confirmar validación</>}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={procesando}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
