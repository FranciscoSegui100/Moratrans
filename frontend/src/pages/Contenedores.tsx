import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Contenedor {
  numero: string;
  estado: string;
  cliente_id: string | null;
  vence_en: string | null;
  actualizado_por: string | null;
  actualizado_en: string;
}

export function Contenedores() {
  const { show } = useToast();
  const [contenedores, setContenedores] = useState<Contenedor[]>([]);
  const [form, setForm] = useState({ numero: '' });
  const [loading, setLoading] = useState(false);

  const cargar = () => api.get<Contenedor[]>('/api/contenedores').then((r) => setContenedores(r.data)).catch(() => {});
  useEffect(() => { cargar(); }, []);

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
              {loading ? 'Guardando...' : '+ Registrar'}
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
              <tr key={c.numero}>
                <td className="mono" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  {c.numero}
                </td>
                <td>
                  <span className={`badge ${c.estado}`}>
                    {c.estado.replace('_', ' ')}
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
    </div>
  );
}
