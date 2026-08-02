import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Pago {
  id: string;
  cliente_telefono: string;
  monto: string | null;
  url_comprobante: string | null;
  estado: string;
  zona: string | null;
  precio: string | null;
  creado_en: string;
}

const API = import.meta.env.VITE_API_URL || '';

export function Pagos() {
  const { show } = useToast();
  const [pagos, setPagos] = useState<Pago[]>([]);
  const [procesando, setProcesando] = useState<string | null>(null);

  const cargar = () => api.get<Pago[]>('/api/pagos?estado=pendiente').then((r) => setPagos(r.data)).catch(() => {});
  useEffect(() => { cargar(); }, []);

  async function validar(id: string) {
    setProcesando(id);
    try {
      const { data } = await api.post(`/api/pagos/${id}/validar`);
      show('success', 'Pago validado', `Ticket ${data.ticket_id} — contenedor ${data.contenedor}`);
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

  return (
    <div>
      <div className="page-header">
        <h2>Validación de pagos</h2>
        <p>Revisá los comprobantes y aprobá o rechazá cada pago pendiente</p>
      </div>

      {pagos.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">✅</div>
            <div className="empty-state-title">Todo al día</div>
            <div className="empty-state-text">No hay pagos pendientes de validación</div>
          </div>
        </div>
      ) : (
        <div className="space-y">
          {pagos.map((p) => (
            <div key={p.id} className="pago-card">
              <div className="pago-avatar">💳</div>

              <div className="pago-info">
                <div className="pago-phone">{p.cliente_telefono}</div>
                <div className="pago-detail">
                  {p.zona ?? 'Sin zona'} ·{' '}
                  {p.precio ? `UYU ${Number(p.precio).toLocaleString('es-UY')}` : 'Sin monto'} ·{' '}
                  {new Date(p.creado_en).toLocaleString('es-UY')}
                </div>
              </div>

              <div className="pago-actions">
                <RoleGate roles={['admin', 'finanzas']}>
                  {p.url_comprobante ? (
                    <a
                      href={`${API}${p.url_comprobante}`}
                      target="_blank"
                      rel="noreferrer"
                      className="comprobante-link"
                    >
                      🖼 Ver comprobante
                    </a>
                  ) : (
                    <span className="text-muted">Sin comprobante</span>
                  )}
                </RoleGate>

                <RoleGate roles={['admin', 'operador', 'finanzas']}>
                  <button
                    onClick={() => validar(p.id)}
                    className="btn btn-success btn-sm"
                    disabled={procesando === p.id}
                  >
                    {procesando === p.id ? '...' : '✓ Validar'}
                  </button>
                  <button
                    onClick={() => rechazar(p.id)}
                    className="btn btn-danger btn-sm"
                    disabled={procesando === p.id}
                  >
                    ✕ Rechazar
                  </button>
                </RoleGate>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
