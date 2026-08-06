import { useState } from 'react';
import { Check } from 'lucide-react';

export interface ValidarPagoPayload {
  diasDemora?: number;
  choferId?: string;
  venceEn?: string;
}

interface Props {
  choferes: { id: string; nombre: string }[];
  procesando: boolean;
  onConfirm: (payload: ValidarPagoPayload) => void;
  onCancel: () => void;
}

/** Formulario que aparece al validar un pago: días para el retiro, chofer asignado y vencimiento. */
export function ValidarPagoForm({ choferes, procesando, onConfirm, onCancel }: Props) {
  const [choferId, setChoferId] = useState('');
  const [dias, setDias] = useState('');
  const [venceEn, setVenceEn] = useState('');

  return (
    <div className="validar-form">
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Chofer asignado</label>
          <select className="form-select" value={choferId} onChange={(e) => setChoferId(e.target.value)}>
            <option value="">— Sin asignar —</option>
            {choferes.map((c) => (
              <option key={c.id} value={c.id}>{c.nombre}</option>
            ))}
          </select>
        </div>
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
          disabled={procesando}
          onClick={() =>
            onConfirm({
              diasDemora: dias !== '' ? Number(dias) : undefined,
              choferId: choferId || undefined,
              venceEn: venceEn || undefined,
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
