import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Ruta {
  id: string;
  fecha: string;
  chofer_id: string;
  chofer_nombre: string | null;
  patente: string | null;
  estado: 'planificada' | 'en_curso' | 'finalizada' | 'cancelada';
  notas: string | null;
  creado_en: string;
}
interface Chofer { id: string; nombre: string; activo: boolean; }

const ETIQUETA_ESTADO: Record<Ruta['estado'], { texto: string; clase: string }> = {
  planificada: { texto: 'Planificada', clase: 'pendiente' },
  en_curso: { texto: 'En curso', clase: 'reservado' },
  finalizada: { texto: 'Finalizada', clase: 'disponible' },
  cancelada: { texto: 'Cancelada', clase: 'rechazado' },
};

const formInicial = { fecha: '', chofer_id: '', notas: '' };

export function Rutas() {
  const { show } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(formInicial);
  const [loading, setLoading] = useState(false);

  const { data: rutas = [] } = useQuery({
    queryKey: ['rutas'],
    queryFn: () => api.get<Ruta[]>('/api/rutas').then((r) => r.data),
  });
  const { data: choferes = [] } = useQuery({
    queryKey: ['choferes', 'activos'],
    queryFn: () => api.get<Chofer[]>('/api/choferes').then((r) => r.data.filter((c) => c.activo)),
  });
  const cargar = () => queryClient.invalidateQueries({ queryKey: ['rutas'] });

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fecha || !form.chofer_id) return;
    setLoading(true);
    try {
      const { data } = await api.post<Ruta>('/api/rutas', { ...form, notas: form.notas || undefined });
      setForm(formInicial);
      cargar();
      show('success', 'Ruta creada', 'Ahora podés armar las paradas.');
      navigate(`/rutas/${data.id}`);
    } catch (err: any) {
      show('error', 'Error al crear la ruta', err.response?.data?.error || 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <RoleGate roles={['admin', 'operador']}>
        <div className="page-header">
          <h2>Rutas</h2>
          <p>Preplanificá el recorrido de un chofer: orden de paradas y contenedor por parada</p>
        </div>

        <div className="form-card">
          <div className="section-title">Nueva ruta</div>
          <form onSubmit={crear} className="form-row">
            <div className="form-group">
              <label className="form-label">Fecha</label>
              <input
                type="date"
                className="form-input"
                value={form.fecha}
                onChange={(e) => setForm({ ...form, fecha: e.target.value })}
                required
              />
            </div>
            <div className="form-group">
              <label className="form-label">Chofer</label>
              <select className="form-select" value={form.chofer_id} onChange={(e) => setForm({ ...form, chofer_id: e.target.value })} required>
                <option value="">— Elegir —</option>
                {choferes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Notas</label>
              <input className="form-input" value={form.notas} onChange={(e) => setForm({ ...form, notas: e.target.value })} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Creando...' : 'Crear ruta'}
            </button>
          </form>
        </div>
      </RoleGate>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Chofer</th>
              <th>Patente</th>
              <th>Estado</th>
              <th>Notas</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rutas.map((r) => {
              const estado = ETIQUETA_ESTADO[r.estado];
              return (
                <tr key={r.id}>
                  <td className="strong">{r.fecha}</td>
                  <td>{r.chofer_nombre ?? <span className="text-muted">—</span>}</td>
                  <td className="mono">{r.patente ?? <span className="text-muted">—</span>}</td>
                  <td><span className={`badge ${estado.clase}`}>{estado.texto}</span></td>
                  <td>{r.notas ?? <span className="text-muted">—</span>}</td>
                  <td>
                    <Link to={`/rutas/${r.id}`} className="btn btn-ghost btn-sm">
                      Armar <ArrowRight size={13} strokeWidth={1.75} />
                    </Link>
                  </td>
                </tr>
              );
            })}
            {rutas.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  No hay rutas creadas todavía
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
