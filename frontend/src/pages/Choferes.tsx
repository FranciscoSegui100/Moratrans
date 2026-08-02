import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Chofer { id: string; nombre: string; dni: string; telefono: string; activo: boolean; }

const avatarColors = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4'];

function initials(name: string) {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function avatarColor(name: string) {
  const i = name.charCodeAt(0) % avatarColors.length;
  return avatarColors[i];
}

export function Choferes() {
  const { show } = useToast();
  const [choferes, setChoferes] = useState<Chofer[]>([]);
  const [form, setForm] = useState({ nombre: '', dni: '', telefono: '' });
  const [loading, setLoading] = useState(false);

  const cargar = () => api.get<Chofer[]>('/api/choferes').then((r) => setChoferes(r.data)).catch(() => {});
  useEffect(() => { cargar(); }, []);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/choferes', form);
      setForm({ nombre: '', dni: '', telefono: '' });
      cargar();
      show('success', 'Chofer creado', form.nombre);
    } catch (err: any) {
      show('error', 'Error al crear', err.response?.data?.error || 'DNI o teléfono duplicado');
    } finally {
      setLoading(false);
    }
  }

  async function borrar(id: string, nombre: string) {
    if (!confirm(`¿Eliminar al chofer ${nombre}?`)) return;
    try {
      await api.delete(`/api/choferes/${id}`);
      cargar();
      show('info', 'Chofer eliminado');
    } catch (err: any) {
      show('error', 'No se puede eliminar', err.response?.data?.error);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Choferes</h2>
        <p>Alta, baja y gestión de choferes del sistema</p>
      </div>

      <RoleGate roles={['admin', 'operador']}>
        <div className="form-card">
          <div className="section-title">Agregar nuevo chofer</div>
          <form onSubmit={crear} className="form-row">
            <div className="form-group">
              <label className="form-label">Nombre completo</label>
              <input className="form-input" placeholder="Ej. Juan Pérez" value={form.nombre} required
                onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">DNI</label>
              <input className="form-input" placeholder="12345678" value={form.dni} required
                onChange={(e) => setForm({ ...form, dni: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Teléfono (E.164)</label>
              <input className="form-input" placeholder="59899123456" value={form.telefono} required
                onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : '+ Agregar'}
            </button>
          </form>
        </div>
      </RoleGate>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Chofer</th>
              <th>DNI</th>
              <th>Teléfono</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {choferes.map((c) => (
              <tr key={c.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div
                      className="avatar"
                      style={{ background: avatarColor(c.nombre) }}
                    >
                      {initials(c.nombre)}
                    </div>
                    <span className="strong">{c.nombre}</span>
                  </div>
                </td>
                <td className="mono">{c.dni}</td>
                <td>{c.telefono}</td>
                <td>
                  <span className={`badge ${c.activo ? 'disponible' : 'cancelado'}`}>
                    {c.activo ? '● Activo' : '● Inactivo'}
                  </span>
                </td>
                <td>
                  <RoleGate roles={['admin', 'operador']}>
                    <button onClick={() => borrar(c.id, c.nombre)} className="btn btn-danger btn-sm">
                      Eliminar
                    </button>
                  </RoleGate>
                </td>
              </tr>
            ))}
            {choferes.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  No hay choferes registrados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
