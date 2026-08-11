import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpFromLine, ArrowDownToLine } from 'lucide-react';
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
  destino_direccion: string | null;
  cliente_telefono: string | null;
  chofer_nombre: string | null;
  notas: string | null;
}
interface Contenedor { numero: string; estado: string; }
interface Tarifa { departamento: string; activo: boolean; }
interface Chofer { id: string; nombre: string; activo: boolean; }

const estados = ['programado', 'en_curso', 'completado', 'cancelado'];

const formInicial = { tipo: 'entrega', fecha: '', zona: '', contenedor_numero: '', chofer_id: '', destino_direccion: '' };

export function Viajes() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(formInicial);
  const [loading, setLoading] = useState(false);

  const { data: viajes = [] } = useQuery({
    queryKey: ['viajes'],
    queryFn: () => api.get<Viaje[]>('/api/viajes').then((r) => r.data),
  });
  const { data: contenedoresDisponibles = [] } = useQuery({
    queryKey: ['contenedores', 'disponibles'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data.filter((c) => c.estado === 'disponible')),
  });
  const { data: zonas = [] } = useQuery({
    queryKey: ['tarifas', 'activas'],
    queryFn: () => api.get<Tarifa[]>('/api/tarifas').then((r) => r.data.filter((t) => t.activo)),
  });
  const { data: choferes = [] } = useQuery({
    queryKey: ['choferes', 'activos'],
    queryFn: () => api.get<Chofer[]>('/api/choferes').then((r) => r.data.filter((c) => c.activo)),
  });
  const cargar = () => queryClient.invalidateQueries({ queryKey: ['viajes'] });

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fecha) return;
    setLoading(true);
    try {
      await api.post('/api/viajes', {
        ...form,
        chofer_id: form.chofer_id || undefined,
        contenedor_numero: form.contenedor_numero || undefined,
        zona: form.zona || undefined,
        destino_direccion: form.destino_direccion || undefined,
      });
      setForm(formInicial);
      cargar();
      show('success', 'Viaje programado correctamente', form.chofer_id ? 'Se avisó al chofer por WhatsApp' : undefined);
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
              <select className="form-select" value={form.zona} onChange={(e) => setForm({ ...form, zona: e.target.value })}>
                <option value="">— Elegir zona —</option>
                {zonas.map((z) => <option key={z.departamento} value={z.departamento}>{z.departamento}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Contenedor</label>
              <select className="form-select" value={form.contenedor_numero} onChange={(e) => setForm({ ...form, contenedor_numero: e.target.value })}>
                <option value="">— Elegir contenedor disponible —</option>
                {contenedoresDisponibles.map((c) => <option key={c.numero} value={c.numero}>{c.numero}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Chofer</label>
              <select className="form-select" value={form.chofer_id} onChange={(e) => setForm({ ...form, chofer_id: e.target.value })}>
                <option value="">— Sin asignar —</option>
                {choferes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Dirección de destino</label>
              <input
                className="form-input"
                placeholder="Ej. Av. San Martín 1234, Godoy Cruz"
                value={form.destino_direccion}
                onChange={(e) => setForm({ ...form, destino_direccion: e.target.value })}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Programar viaje'}
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
                    {v.tipo === 'entrega' ? <ArrowUpFromLine size={11} strokeWidth={2} /> : <ArrowDownToLine size={11} strokeWidth={2} />} {v.tipo}
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
