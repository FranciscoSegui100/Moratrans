import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { formatearFechaHora } from '../lib/fechas';

interface Comprobante {
  id: string;
  cliente_telefono: string;
  cliente_nombre: string | null;
  monto: string | null;
  estado: string;
  tipo: 'flete' | 'alargue_retiro';
  creado_en: string;
  titular_transferencia: string | null;
  zona: string | null;
  precio: string | null;
  moneda: string | null;
}

export function Comprobantes() {
  const { data: comprobantes = [] } = useQuery({
    queryKey: ['dashboard', 'comprobantes'],
    queryFn: () => api.get<Comprobante[]>('/api/dashboard/comprobantes').then((r) => r.data),
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Comprobantes</h2>
          <p style={{ fontSize: '1rem' }}>Histórico de comprobantes de pago enviados por los clientes</p>
        </div>
      </div>

      <div className="card">
        <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Receipt size={16} strokeWidth={1.75} />
          Comprobantes enviados
          <span className="badge programado" style={{ fontSize: '0.72rem' }}>{comprobantes.length}</span>
        </div>

        {comprobantes.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Receipt strokeWidth={1.5} /></div>
            <div className="empty-state-title">Sin comprobantes</div>
            <div className="empty-state-text">Todavía no llegó ningún comprobante de pago</div>
          </div>
        ) : (
          <div className="space-y">
            {comprobantes.map((c) => (
              <div key={c.id} className="pago-card">
                <div className="pago-card-top">
                  <div className="pago-avatar"><Receipt strokeWidth={1.75} /></div>
                  <div className="pago-info">
                    <div className="pago-phone">
                      {c.cliente_nombre ? `${c.cliente_nombre} · ${c.cliente_telefono}` : c.cliente_telefono}{' '}
                      <span className={`badge ${c.estado}`} style={{ marginLeft: '6px' }}>{c.estado}</span>
                    </div>
                    <div className="pago-detail">
                      {c.tipo === 'alargue_retiro' ? '⏳ Alargue de retiro' : (c.zona ?? 'Sin zona')} ·{' '}
                      {c.precio
                        ? `${c.moneda ?? ''} ${Number(c.precio).toLocaleString('es-AR')}`.trim()
                        : c.monto
                        ? `${c.moneda ?? ''} ${Number(c.monto).toLocaleString('es-AR')}`.trim()
                        : 'Sin monto'}{' '}
                      · {formatearFechaHora(c.creado_en)}
                    </div>
                    {c.titular_transferencia && (
                      <div className="pago-detail">Transferencia a nombre de: <strong>{c.titular_transferencia}</strong></div>
                    )}
                    <RoleGate roles={['admin', 'finanzas']}>
                      <ComprobanteViewer pagoId={c.id} />
                    </RoleGate>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
