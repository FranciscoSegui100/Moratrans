import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { formatearFechaHora } from '../lib/fechas';

interface Contenedor {
  numero: string;
  estado: string;
  estado_contrato: string;
  cliente_id: string | null;
  vence_en: string | null;
  actualizado_por: string | null;
  actualizado_en: string;
  viaje_tipo: 'entrega' | 'retiro' | null;
  chofer_asignado: string | null;
}
interface HistorialItem {
  id: string;
  estado: string;
  creado_en: string;
  realizado_por: string;
  ticket_id: string | null;
  ticket_zona: string | null;
  ticket_cliente_telefono: string | null;
}
interface GrupoHistorial {
  ticket_id: string | null;
  ticket_zona: string | null;
  ticket_cliente_telefono: string | null;
  items: HistorialItem[];
}

const ETIQUETAS_ESTADO: Record<string, string> = {
  disponible: 'Disponible',
  alquilado: 'Alquilado',
  para_retirar: 'Para retirar',
  yendo_a_vaciar: 'Yendo a vaciar',
  vencido: 'Vencido',
};

/** El historial viene ordenado por fecha desc; se agrupa por ticket sin
 * reordenar, así cada ciclo de alquiler queda junto en vez de mezclado. */
function agruparPorTicket(historial: HistorialItem[]): GrupoHistorial[] {
  const grupos: GrupoHistorial[] = [];
  for (const h of historial) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.ticket_id === h.ticket_id) {
      ultimo.items.push(h);
    } else {
      grupos.push({ ticket_id: h.ticket_id, ticket_zona: h.ticket_zona, ticket_cliente_telefono: h.ticket_cliente_telefono, items: [h] });
    }
  }
  return grupos;
}

export function Contenedores() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ numero: '' });
  const [loading, setLoading] = useState(false);
  const [historialNumero, setHistorialNumero] = useState<string | null>(null);

  const { data: contenedores = [] } = useQuery({
    queryKey: ['contenedores'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data),
  });
  const cargar = () => queryClient.invalidateQueries({ queryKey: ['contenedores'] });

  const { data: historial = [], isLoading: cargandoHistorial } = useQuery({
    queryKey: ['contenedores', historialNumero, 'historial'],
    queryFn: () => api.get<HistorialItem[]>(`/api/contenedores/${historialNumero}/historial`).then((r) => r.data),
    enabled: historialNumero !== null,
  });

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/contenedores', form);
      setForm({ numero: '' });
      cargar();
      show('success', 'Contenedor creado', form.numero.toUpperCase());
    } catch (err: any) {
      show('error', 'Error al crear', err.response?.data?.error || 'El número ya existe');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Contenedores</h2>
        <p>Alta y seguimiento del inventario de contenedores</p>
      </div>

      <RoleGate roles={['admin', 'operador']}>
        <div className="form-card">
          <div className="section-title">Registrar contenedor</div>
          <form onSubmit={crear} className="form-row">
            <div className="form-group">
              <label className="form-label">Número de contenedor</label>
              <input
                className="form-input"
                placeholder="Ej. MSKU1234567"
                value={form.numero}
                required
                style={{ textTransform: 'uppercase' }}
                onChange={(e) => setForm({ numero: e.target.value })}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Registrar contenedor'}
            </button>
          </form>
        </div>
      </RoleGate>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Estado</th>
              <th>Chofer asignado</th>
              <th>Vence</th>
              <th>Última actualización</th>
            </tr>
          </thead>
          <tbody>
            {contenedores.map((c) => (
              <tr key={c.numero} onClick={() => setHistorialNumero(c.numero)} style={{ cursor: 'pointer' }}>
                <td className="mono" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  {c.numero}
                </td>
                <td>
                  <span className={`badge ${c.estado_contrato}`}>
                    {ETIQUETAS_ESTADO[c.estado_contrato] ?? c.estado_contrato.replace('_', ' ')}
                  </span>
                </td>
                <td>
                  {c.chofer_asignado ? (
                    <span>
                      {c.chofer_asignado}{' '}
                      <span className="text-muted">({c.viaje_tipo})</span>
                    </span>
                  ) : (c.estado === 'reservado' || c.estado === 'entregado') ? (
                    <span style={{ color: 'var(--danger)' }} title="Contenedor sin chofer ni viaje asignado">
                      Sin asignar
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {c.vence_en ? (
                    <span style={{ color: new Date(c.vence_en) < new Date() ? 'var(--danger)' : 'var(--warning)' }}>
                      {formatearFechaHora(c.vence_en)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="text-muted" style={{ whiteSpace: 'nowrap' }}>
                  {formatearFechaHora(c.actualizado_en)}{' '}
                  {c.actualizado_por && <span>· {c.actualizado_por}</span>}
                </td>
              </tr>
            ))}
            {contenedores.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  No hay contenedores registrados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {historialNumero && (
        <div className="modal-overlay" onClick={() => setHistorialNumero(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="section-title" style={{ margin: 0 }}>
                Historial · {historialNumero}
              </div>
              <button className="modal-close" onClick={() => setHistorialNumero(null)}>
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            {cargandoHistorial && <p className="text-muted">Cargando historial…</p>}
            {!cargandoHistorial && historial.length === 0 && (
              <p className="text-muted">Sin movimientos registrados para este contenedor.</p>
            )}
            {!cargandoHistorial && historial.length > 0 && agruparPorTicket(historial).map((grupo, i) => (
              <div key={grupo.ticket_id ?? `sin-ticket-${i}`} style={{ marginBottom: 18 }}>
                <div className="section-title" style={{ marginBottom: 6 }}>
                  {grupo.ticket_id
                    ? `Ticket ${grupo.ticket_id.slice(0, 8)}${grupo.ticket_zona ? ` · ${grupo.ticket_zona}` : ''}${grupo.ticket_cliente_telefono ? ` · ${grupo.ticket_cliente_telefono}` : ''}`
                    : 'Sin ticket asociado'}
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Estado</th>
                      <th>Hecho por</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grupo.items.map((h) => (
                      <tr key={h.id}>
                        <td className="text-muted" style={{ whiteSpace: 'nowrap' }}>{formatearFechaHora(h.creado_en)}</td>
                        <td>
                          <span className={`badge ${h.estado}`}>{h.estado.replace('_', ' ')}</span>
                        </td>
                        <td>{h.realizado_por}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
