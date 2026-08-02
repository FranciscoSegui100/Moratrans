import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Viaje {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  estado: string;
  zona: string | null;
  contenedor_numero: string | null;
  cliente_telefono: string | null;
  chofer_nombre: string | null;
  notas: string | null;
}

const estados = ['programado', 'en_curso', 'completado', 'cancelado'];

export function Viajes() {
  const { show } = useToast();
  const [viajes, setViajes] = useState<Viaje[]>([]);
  const [form, setForm] = useState({ tipo: 'entrega', fecha: '', zona: '', contenedor_numero: '' });
  const [loading, setLoading] = useState(false);

  const cargar = () => api.get<Viaje[]>('/api/viajes').then((r) => setViajes(r.data)).catch(() => {});
  useEffect(() => { cargar(); }, []);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fecha) return;
    setLoading(true);
    try {
      await api.post('/api/viajes', form);
      setForm({ tipo: 'entrega', fecha: '', zona: '', contenedor_numero: '' });
      cargar();
      show('success', 'Viaje programado correctamente');
    } catch (err: any) {
      show('error', 'Error al programar', err.response?.data?.error || 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }

  async function cambiarEstado(id: string, estado: string) {
    try {
      await api.patch(`/api/viajes/${id}`, { estado });
      cargar();
    } catch {
      show('error', 'No se pudo cambiar el estado');
    }
  }

  async function borrar(id: string) {
    if (!confirm('¿Seguro que deseas eliminar este viaje?')) return;
    try {
      await api.delete(`/api/viajes/${id}`);
      cargar();
      show('info', 'Viaje eliminado');
    } catch (err: any) {
      show('error', 'No se puede eliminar', err.response?.data?.error);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Viajes programados</h2>
        <p>Gestión de entregas y retiros de contenedores</p>
      </div>

      <RoleGate roles={['admin', 'operador']}>
        <div className="form-card">
          <div className="section-title">Programar nuevo viaje</div>
          <form onSubmit={crear} className="form-row">
            <div className="form-group">
              <label className="form-label">Tipo</label>
              <select className="form-select" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
                <option value="entrega">Entrega</option>
                <option value="retiro">Retiro</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Fecha</label>
              <input type="date" className="form-input" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} required />
            </div>
            <div className="form-group">
              <label className="form-label">Zona</label>
              <input className="form-input" placeholder="Ej. Montevideo" value={form.zona} onChange={(e) => setForm({ ...form, zona: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Contenedor</label>
              <input className="form-input" placeholder="Ej. MSKU1000001" value={form.contenedor_numero} onChange={(e) => setForm({ ...form, contenedor_numero: e.target.value })} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : '+ Programar'}
            </button>
          </form>
        </div>
      </RoleGate>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Zona</th>
              <th>Contenedor</th>
              <th>Chofer</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {viajes.map((v) => (
              <tr key={v.id}>
                <td className="strong">{v.fecha}</td>
                <td>
                  <span className={`badge ${v.tipo === 'entrega' ? 'reservado' : 'retirado'}`}>
                    {v.tipo === 'entrega' ? '📤' : '📥'} {v.tipo}
                  </span>
                </td>
                <td>{v.zona ?? '—'}</td>
                <td className="mono">{v.contenedor_numero ?? '—'}</td>
                <td>{v.chofer_nombre ?? <span className="text-muted">Sin asignar</span>}</td>
                <td>
                  <RoleGate roles={['admin', 'operador']}>
                    <select
                      className="form-select"
                      style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                      value={v.estado}
                      onChange={(e) => cambiarEstado(v.id, e.target.value)}
                    >
                      {estados.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </RoleGate>
                </td>
                <td>
                  <RoleGate roles={['admin']}>
                    {v.estado === 'completado' && (
                      <button onClick={() => borrar(v.id)} className="btn btn-danger btn-sm">
                        Eliminar
                      </button>
                    )}
                  </RoleGate>
                </td>
              </tr>
            ))}
            {viajes.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  No hay viajes cargados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
