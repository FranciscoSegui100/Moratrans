import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Check, X, RotateCcw, CircleCheck } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { ValidarPagoForm, ValidarPagoPayload } from '../components/ValidarPagoForm';
import { useToast } from '../components/Toast';

interface Pago {
  id: string;
  cliente_telefono: string;
  monto: string | null;
  url_comprobante: string | null;
  estado: string;
  zona: string | null;
  precio: string | null;
  moneda: string | null;
  creado_en: string;
}

interface Chofer { id: string; nombre: string; activo: boolean; }

export function Pagos() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [procesando, setProcesando] = useState<string | null>(null);
  const [validandoId, setValidandoId] = useState<string | null>(null);

  const { data: pagos = [] } = useQuery({
    queryKey: ['pagos', 'pendiente'],
    queryFn: () => api.get<Pago[]>('/api/pagos?estado=pendiente').then((r) => r.data),
  });
  const { data: choferes = [] } = useQuery({
    queryKey: ['choferes', 'activos'],
    queryFn: () => api.get<Chofer[]>('/api/choferes').then((r) => r.data.filter((c) => c.activo)),
  });

  const cargar = () => queryClient.invalidateQueries({ queryKey: ['pagos', 'pendiente'] });

  async function validar(id: string, payload: ValidarPagoPayload) {
    setProcesando(id);
    try {
      const { data } = await api.post(`/api/pagos/${id}/validar`, payload);
      show('success', 'Pago validado', `Ticket ${data.ticket_id} — contenedor ${data.contenedor}`);
      setValidandoId(null);
      cargar();
    } catch (e: any) {
      show('error', 'Error al validar', e.response?.data?.error || 'Error desconocido');
    } finally {
      setProcesando(null);
    }
  }

  async function rechazar(id: string) {
    const motivo = prompt('Motivo del rechazo:') || 'Comprobante no válido';
    setProcesando(id);
    try {
      await api.post(`/api/pagos/${id}/rechazar`, { motivo });
      show('info', 'Pago rechazado', motivo);
      cargar();
    } catch {
      show('error', 'Error al rechazar');
    } finally {
      setProcesando(null);
    }
  }

  /** No es un rechazo real: le pide al cliente que reenvíe el comprobante (ej. foto no legible). */
  async function pedirDeNuevo(id: string) {
    setProcesando(id);
    try {
      await api.post(`/api/pagos/${id}/rechazar`, {
        motivo: 'Comprobante no legible. Por favor, enviá una foto más clara.',
      });
      show('info', 'Le pedimos al cliente que reenvíe el comprobante', 'Se le avisó por WhatsApp');
      cargar();
    } catch {
      show('error', 'No se pudo avisar al cliente');
    } finally {
      setProcesando(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Validación de pagos</h2>
        <p>Revisá los comprobantes y aprobá o rechazá cada pago pendiente</p>
      </div>

      {pagos.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><CircleCheck strokeWidth={1.5} /></div>
            <div className="empty-state-title">Todo al día</div>
            <div className="empty-state-text">No hay pagos pendientes de validación</div>
          </div>
        </div>
      ) : (
        <div className="space-y">
          {pagos.map((p) => (
            <div key={p.id} className={`pago-card ${validandoId === p.id ? 'pago-card-expandido' : ''}`}>
              <div className="pago-card-top">
                <div className="pago-avatar"><CreditCard strokeWidth={1.75} /></div>

                <div className="pago-info">
                  <div className="pago-phone">{p.cliente_telefono}</div>
                  <div className="pago-detail">
                    {p.zona ?? 'Sin zona'} ·{' '}
                    {p.precio ? `${p.moneda ?? ''} ${Number(p.precio).toLocaleString('es-AR')}`.trim() : 'Sin monto'} ·{' '}
                    {new Date(p.creado_en).toLocaleString('es-UY')}
                  </div>
                  <RoleGate roles={['admin', 'finanzas']}>
                    {p.url_comprobante ? (
                      <ComprobanteViewer pagoId={p.id} />
                    ) : (
                      <span className="text-muted">Sin comprobante</span>
                    )}
                  </RoleGate>
                </div>

                <div className="pago-actions">
                  <RoleGate roles={['admin', 'operador', 'finanzas']}>
                    {validandoId !== p.id && (
                      <button
                        onClick={() => setValidandoId(p.id)}
                        className="btn btn-success btn-sm"
                        disabled={procesando === p.id}
                      >
                        <Check strokeWidth={2} /> Validar
                      </button>
                    )}
                    <button
                      onClick={() => rechazar(p.id)}
                      className="btn btn-danger btn-sm"
                      disabled={procesando === p.id}
                    >
                      <X strokeWidth={2} /> Rechazar
                    </button>
                    <button
                      onClick={() => pedirDeNuevo(p.id)}
                      className="btn btn-ghost btn-sm"
                      disabled={procesando === p.id}
                      title="El comprobante no se lee bien: le pedimos al cliente que lo reenvíe"
                    >
                      <RotateCcw strokeWidth={1.75} /> Pedir de nuevo
                    </button>
                  </RoleGate>
                </div>
              </div>

              {validandoId === p.id && (
                <ValidarPagoForm
                  choferes={choferes}
                  procesando={procesando === p.id}
                  onConfirm={(payload) => validar(p.id, payload)}
                  onCancel={() => setValidandoId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
