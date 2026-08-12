import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Contenedor {
  numero: string;
  estado: string;
  estado_contrato: string;
  cliente_id: string | null;
  vence_en: string | null;
  actualizado_por: string | null;
  actualizado_en: string;
}
interface HistorialItem {
  id: string;
  estado: string;
  nota: string | null;
  creado_en: string;
  chofer_nombre: string | null;
}

const ETIQUETAS_ESTADO: Record<string, string> = {
  disponible: 'Disponible',
  alquilado: 'Alquilado',
  para_retirar: 'Para retirar',
  vencido: 'Vencido',
};

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
                  {c.vence_en ? (
                    <span style={{ color: new Date(c.vence_en) < new Date() ? 'var(--danger)' : 'var(--warning)' }}>
                      {new Date(c.vence_en).toLocaleString('es-UY')}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="text-muted">
                  {new Date(c.actualizado_en).toLocaleString('es-UY')}{' '}
                  {c.actualizado_por && <span>· {c.actualizado_por}</span>}
                </td>
              </tr>
            ))}
            {contenedores.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
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
            {!cargandoHistorial && historial.length > 0 && (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Estado</th>
                    <th>Chofer</th>
                    <th>Nota</th>
                  </tr>
                </thead>
                <tbody>
                  {historial.map((h) => (
                    <tr key={h.id}>
                      <td className="text-muted">{new Date(h.creado_en).toLocaleString('es-UY')}</td>
                      <td>
                        <span className={`badge ${h.estado}`}>{h.estado.replace('_', ' ')}</span>
                      </td>
                      <td>{h.chofer_nombre ?? <span className="text-muted">—</span>}</td>
                      <td>{h.nota ?? <span className="text-muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
