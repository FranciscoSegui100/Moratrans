import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpFromLine, ArrowDownToLine, RefreshCw } from 'lucide-react';
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
  contenedor_estado: string | null;
  destino_direccion: string | null;
  cliente_telefono: string | null;
  chofer_nombre: string | null;
  chofer_id: string | null;
  patente: string | null;
  grupo_id: string | null;
  notas: string | null;
}
interface Contenedor { numero: string; estado: string; vence_en: string | null; }
interface Tarifa { departamento: string; activo: boolean; }
interface Chofer { id: string; nombre: string; activo: boolean; }

const estados = ['programado', 'en_curso', 'completado', 'cancelado'];

const ETIQUETAS_ESTADO_CONTENEDOR: Record<string, string> = {
  disponible: 'Disponible',
  alquilado: 'Alquilado',
  para_retirar: 'Para retirar',
  vencido: 'Vencido',
};

const formInicial = { tipo: 'entrega', fecha: '', zona: '', contenedor_numero: '', chofer_id: '', destino_direccion: '' };

export function Viajes() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(formInicial);
  const [loading, setLoading] = useState(false);
  const [asignando, setAsignando] = useState<string | null>(null);
  const [asignarForm, setAsignarForm] = useState({ contenedor_numero: '', chofer_id: '' });

  const { data: viajes = [] } = useQuery({
    queryKey: ['viajes'],
    queryFn: () => api.get<Viaje[]>('/api/viajes').then((r) => r.data),
  });
  const { data: contenedores = [] } = useQuery({
    queryKey: ['contenedores'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data),
  });
  // Retiro: se va a buscar un contenedor que ya está entregado en lo del
  // cliente (venció el alquiler). Entrega: se puede elegir cualquier
  // contenedor que no tenga ya otra entrega reservada — si está ocupado, el
  // combo lo deja elegir igual pero avisando desde cuándo vuelve, y el
  // input de fecha se bloquea hasta ese día (ver minFecha más abajo).
  const entregasActivas = new Set(
    viajes.filter((v) => v.tipo === 'entrega' && (v.estado === 'programado' || v.estado === 'en_curso')).map((v) => v.contenedor_numero),
  );
  const contenedoresElegibles = form.tipo === 'retiro'
    ? contenedores.filter((c) => c.estado === 'entregado')
    : contenedores.filter((c) => !entregasActivas.has(c.numero));

  const contenedorSeleccionado = contenedores.find((c) => c.numero === form.contenedor_numero);
  // Si el contenedor elegido para una entrega está ocupado, no se puede
  // programar para antes de que vuelva — este es el "calendario bloqueado
  // hasta el día de vuelta".
  const minFecha = form.tipo === 'entrega' && contenedorSeleccionado && contenedorSeleccionado.estado !== 'disponible' && contenedorSeleccionado.vence_en
    ? new Date(contenedorSeleccionado.vence_en).toISOString().slice(0, 10)
    : undefined;

  function etiquetaContenedor(c: Contenedor): { texto: string; disabled: boolean } {
    if (form.tipo === 'retiro' || c.estado === 'disponible') return { texto: c.numero, disabled: false };
    if (!c.vence_en) return { texto: `${c.numero} — ${c.estado}, sin fecha de vuelta cargada`, disabled: true };
    const fecha = new Date(c.vence_en).toLocaleDateString('es-AR');
    return { texto: `${c.numero} — vuelve el ${fecha}`, disabled: false };
  }
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

  /** Completa la fila 'entrega' de un recambio (se crea sin contenedor, ver recambio.flow.ts). */
  async function asignarContenedor(id: string) {
    if (!asignarForm.contenedor_numero) return;
    try {
      await api.patch(`/api/viajes/${id}`, {
        contenedor_numero: asignarForm.contenedor_numero,
        chofer_id: asignarForm.chofer_id || undefined,
      });
      setAsignando(null);
      setAsignarForm({ contenedor_numero: '', chofer_id: '' });
      cargar();
      show('success', 'Contenedor asignado');
    } catch (err: any) {
      show('error', 'No se pudo asignar', err.response?.data?.error);
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
              <select
                className="form-select"
                value={form.tipo}
                onChange={(e) => setForm({ ...form, tipo: e.target.value, contenedor_numero: '' })}
              >
                <option value="entrega">Entrega</option>
                <option value="retiro">Retiro</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Fecha</label>
              <input
                type="date"
                className="form-input"
                value={form.fecha}
                min={minFecha}
                onChange={(e) => setForm({ ...form, fecha: e.target.value })}
                required
              />
              {minFecha && (
                <small className="text-muted">Contenedor ocupado: recién se puede elegir desde el {new Date(minFecha).toLocaleDateString('es-AR')}</small>
              )}
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
              <select
                className="form-select"
                value={form.contenedor_numero}
                onChange={(e) => {
                  const numero = e.target.value;
                  const c = contenedores.find((x) => x.numero === numero);
                  const nuevoMin = form.tipo === 'entrega' && c && c.estado !== 'disponible' && c.vence_en
                    ? new Date(c.vence_en).toISOString().slice(0, 10)
                    : undefined;
                  setForm((f) => ({ ...f, contenedor_numero: numero, fecha: nuevoMin && f.fecha < nuevoMin ? nuevoMin : f.fecha }));
                }}
              >
                <option value="">
                  {form.tipo === 'retiro' ? '— Elegir contenedor entregado —' : '— Elegir contenedor —'}
                </option>
                {contenedoresElegibles.map((c) => {
                  const { texto, disabled } = etiquetaContenedor(c);
                  return <option key={c.numero} value={c.numero} disabled={disabled}>{texto}</option>;
                })}
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
              <th>Estado contenedor</th>
              <th>Chofer</th>
              <th>Patente</th>
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
                  {v.grupo_id && (
                    <span title="Es parte de un recambio: entrega de vacío + retiro de lleno en la misma visita" style={{ marginLeft: '6px' }}>
                      <RefreshCw size={11} strokeWidth={2} style={{ color: 'var(--accent)' }} />
                    </span>
                  )}
                </td>
                <td>{v.zona ?? '—'}</td>
                <td className="mono">
                  {v.contenedor_numero ? (
                    v.contenedor_numero
                  ) : asignando === v.id ? (
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <select
                        className="form-select"
                        style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                        value={asignarForm.contenedor_numero}
                        onChange={(e) => setAsignarForm({ ...asignarForm, contenedor_numero: e.target.value })}
                      >
                        <option value="">— Vacío —</option>
                        {contenedores.filter((c) => c.estado === 'disponible').map((c) => (
                          <option key={c.numero} value={c.numero}>{c.numero}</option>
                        ))}
                      </select>
                      <button className="btn btn-success btn-sm" onClick={() => asignarContenedor(v.id)}>OK</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setAsignando(null)}>✕</button>
                    </div>
                  ) : (
                    <RoleGate roles={['admin', 'operador']}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setAsignando(v.id); setAsignarForm({ contenedor_numero: '', chofer_id: v.chofer_id ?? '' }); }}
                      >
                        Asignar
                      </button>
                    </RoleGate>
                  )}
                </td>
                <td>
                  {v.contenedor_estado ? (
                    <span className={`badge ${v.contenedor_estado}`}>
                      {ETIQUETAS_ESTADO_CONTENEDOR[v.contenedor_estado] ?? v.contenedor_estado.replace('_', ' ')}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td>{v.chofer_nombre ?? <span className="text-muted">Sin asignar</span>}</td>
                <td className="mono">{v.patente ?? <span className="text-muted">—</span>}</td>
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
                <td colSpan={9} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
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
