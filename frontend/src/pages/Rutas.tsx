import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, RefreshCw } from 'lucide-react';
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
interface Contenedor { numero: string; estado: string; }
interface ViajePendiente {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  zona: string | null;
  contenedor_numero: string | null;
  destino_direccion: string | null;
  cliente_telefono: string | null;
  chofer_id: string | null;
  grupo_id: string | null;
}
/** Un recambio son dos filas (retiro+entrega) que comparten grupo_id — se muestran como una sola visita. */
interface VisitaPendiente {
  id: string;
  fecha: string;
  zona: string | null;
  destino_direccion: string | null;
  cliente_telefono: string | null;
  chofer_id: string | null;
  entrega?: ViajePendiente;
  retiro?: ViajePendiente;
}
function agruparPendientes(viajes: ViajePendiente[]): VisitaPendiente[] {
  const porGrupo = new Map<string, VisitaPendiente>();
  const sueltas: VisitaPendiente[] = [];
  for (const v of viajes) {
    if (!v.grupo_id) {
      sueltas.push({ id: v.id, fecha: v.fecha, zona: v.zona, destino_direccion: v.destino_direccion, cliente_telefono: v.cliente_telefono, chofer_id: v.chofer_id, [v.tipo]: v } as VisitaPendiente);
      continue;
    }
    let visita = porGrupo.get(v.grupo_id);
    if (!visita) {
      visita = { id: v.grupo_id, fecha: v.fecha, zona: v.zona, destino_direccion: v.destino_direccion, cliente_telefono: v.cliente_telefono, chofer_id: v.chofer_id };
      porGrupo.set(v.grupo_id, visita);
    }
    visita[v.tipo] = v;
  }
  return [...sueltas, ...porGrupo.values()];
}

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
  // Viajes ya validados (pago u operador) pero sin chofer/ruta todavía — se
  // actualiza solo, sin tener que crear una ruta a mano primero.
  const { data: pendientes = [] } = useQuery({
    queryKey: ['viajes', 'pendientes-sin-rutear'],
    queryFn: () => api.get<ViajePendiente[]>('/api/viajes?ruta_id=null&estado=programado').then((r) => r.data),
    refetchInterval: 15000,
  });
  const { data: contenedores = [] } = useQuery({
    queryKey: ['contenedores'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data.filter((c) => c.estado === 'disponible')),
  });
  const visitasPendientes = agruparPendientes(pendientes);
  const cargar = () => queryClient.invalidateQueries({ queryKey: ['rutas'] });
  const cargarPendientes = () => queryClient.invalidateQueries({ queryKey: ['viajes', 'pendientes-sin-rutear'] });

  // Un recambio son dos filas (retiro+entrega); el chofer es uno solo para
  // toda la visita, así que hay que reflejarlo en ambas.
  async function asignarChofer(visita: VisitaPendiente, choferId: string) {
    const ids = [visita.entrega?.id, visita.retiro?.id].filter((id): id is string => !!id);
    try {
      await Promise.all(ids.map((id) => api.patch(`/api/viajes/${id}`, { chofer_id: choferId || null })));
      cargarPendientes();
    } catch (err: any) {
      show('error', 'No se pudo asignar el chofer', err.response?.data?.error);
    }
  }

  async function asignarContenedor(viajeId: string, contenedorNumero: string) {
    if (!contenedorNumero) return;
    try {
      await api.patch(`/api/viajes/${viajeId}`, { contenedor_numero: contenedorNumero });
      cargarPendientes();
    } catch (err: any) {
      show('error', 'No se pudo asignar el contenedor', err.response?.data?.error);
    }
  }

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
          <div className="section-title">Viajes pendientes de asignar</div>
          {visitasPendientes.length === 0 && <p className="text-muted">No hay viajes esperando chofer o contenedor.</p>}
          {visitasPendientes.map((v) => {
            const principal = v.entrega ?? v.retiro!;
            return (
              <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <span className="text-muted">{v.fecha}</span>{' '}
                  {v.entrega && v.retiro ? (
                    <span className="badge reservado"><RefreshCw size={11} strokeWidth={2} /> Recambio</span>
                  ) : (
                    <span className={`badge ${principal.tipo === 'entrega' ? 'reservado' : 'retirado'}`}>{principal.tipo}</span>
                  )}
                  {' '}
                  {v.entrega?.contenedor_numero && <span className="mono">{v.entrega.contenedor_numero}</span>}
                  {v.retiro?.contenedor_numero && <span className="mono"> {v.retiro.contenedor_numero}</span>}
                  {' '}
                  <span className="text-muted">{v.destino_direccion ?? v.cliente_telefono ?? ''}</span>
                </div>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  {v.entrega && !v.entrega.contenedor_numero && (
                    <select
                      className="form-select"
                      style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                      value=""
                      onChange={(e) => asignarContenedor(v.entrega!.id, e.target.value)}
                    >
                      <option value="">— Contenedor vacío —</option>
                      {contenedores.map((c) => <option key={c.numero} value={c.numero}>{c.numero}</option>)}
                    </select>
                  )}
                  <select
                    className="form-select"
                    style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                    value={v.chofer_id ?? ''}
                    onChange={(e) => asignarChofer(v, e.target.value)}
                  >
                    <option value="">— Sin chofer —</option>
                    {choferes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
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
