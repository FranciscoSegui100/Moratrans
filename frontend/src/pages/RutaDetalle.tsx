import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUp, ArrowDown, Plus, X, RefreshCw, CheckCircle2 } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface ParadaViaje {
  tipo_parada: 'viaje';
  id: string;
  orden: number;
  viaje_tipo: 'entrega' | 'retiro';
  contenedor_numero: string | null;
  destino_direccion: string | null;
  zona: string | null;
  cliente_telefono: string | null;
  grupo_id: string | null;
  estado: string;
  notas: string | null;
  disponibles?: string[];
}
interface ParadaVaciado {
  tipo_parada: 'vaciado';
  id: string;
  orden: number;
  ubicacion_id: string | null;
  ubicacion_nombre: string | null;
  notas: string | null;
}
type Parada = ParadaViaje | ParadaVaciado;

interface RutaData {
  id: string;
  fecha: string;
  chofer_id: string;
  chofer_nombre: string | null;
  patente: string | null;
  estado: 'planificada' | 'en_curso' | 'finalizada' | 'cancelada';
  notas: string | null;
  paradas: Parada[];
}

interface ViajeCola {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  zona: string | null;
  contenedor_numero: string | null;
  destino_direccion: string | null;
  cliente_telefono: string | null;
  grupo_id: string | null;
}

interface Ubicacion { id: string; tipo: 'deposito' | 'vaciadero'; nombre: string; activo: boolean; }

/** Agrupa las paradas (ya ordenadas por el backend) en "visitas": un recambio son dos filas de `viajes` que comparten `orden` y se muestran como una sola. */
interface Visita {
  orden: number;
  id: string;
  tipoParada: 'viaje' | 'vaciado';
  entrega?: ParadaViaje;
  retiro?: ParadaViaje;
  vaciado?: ParadaVaciado;
}
function agruparVisitas(paradas: Parada[]): Visita[] {
  const porOrden = new Map<number, Visita>();
  for (const p of paradas) {
    let v = porOrden.get(p.orden);
    if (!v) { v = { orden: p.orden, id: p.id, tipoParada: p.tipo_parada }; porOrden.set(p.orden, v); }
    if (p.tipo_parada === 'vaciado') { v.vaciado = p; v.id = p.id; v.tipoParada = 'vaciado'; }
    else if (p.viaje_tipo === 'entrega') { v.entrega = p; v.id = p.id; v.tipoParada = 'viaje'; }
    else { v.retiro = p; if (!v.entrega) v.id = p.id; v.tipoParada = 'viaje'; }
  }
  return [...porOrden.values()].sort((a, b) => a.orden - b.orden);
}

export function RutaDetalle() {
  const { id = '' } = useParams<{ id: string }>();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [agregandoVaciado, setAgregandoVaciado] = useState(false);
  const [vaciadoForm, setVaciadoForm] = useState({ ubicacion_id: '', notas: '' });
  const [confirmando, setConfirmando] = useState(false);

  const { data: ruta } = useQuery({
    queryKey: ['rutas', id],
    queryFn: () => api.get<RutaData>(`/api/rutas/${id}`).then((r) => r.data),
  });
  const { data: cola = [] } = useQuery({
    queryKey: ['viajes', 'sin-rutear'],
    queryFn: () => api.get<ViajeCola[]>('/api/viajes?ruta_id=null&estado=programado').then((r) => r.data),
  });
  const { data: ubicaciones = [] } = useQuery({
    queryKey: ['ubicaciones'],
    queryFn: () => api.get<Ubicacion[]>('/api/ubicaciones').then((r) => r.data.filter((u) => u.activo)),
  });
  const vaciaderos = ubicaciones.filter((u) => u.tipo === 'vaciadero');

  const cargar = () => {
    queryClient.invalidateQueries({ queryKey: ['rutas', id] });
    queryClient.invalidateQueries({ queryKey: ['viajes', 'sin-rutear'] });
  };

  const visitas = ruta ? agruparVisitas(ruta.paradas) : [];
  const editable = ruta?.estado === 'planificada';

  async function agregarParada(viajeId: string) {
    try {
      await api.post(`/api/rutas/${id}/paradas`, { viaje_id: viajeId });
      cargar();
    } catch (err: any) {
      show('error', 'No se pudo agregar la parada', err.response?.data?.error);
    }
  }

  async function agregarVaciado(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/api/rutas/${id}/paradas/vaciado`, {
        ubicacion_id: vaciadoForm.ubicacion_id || undefined,
        notas: vaciadoForm.notas || undefined,
      });
      setAgregandoVaciado(false);
      setVaciadoForm({ ubicacion_id: '', notas: '' });
      cargar();
      show('success', 'Vaciado agregado a la ruta');
    } catch (err: any) {
      show('error', 'No se pudo agregar el vaciado', err.response?.data?.error);
    }
  }

  async function quitarParada(v: Visita) {
    if (!confirm('¿Quitar esta parada de la ruta? Vuelve a la cola sin rutear.')) return;
    try {
      await api.delete(`/api/rutas/${id}/paradas/${v.tipoParada}/${v.id}`);
      cargar();
    } catch (err: any) {
      show('error', 'No se pudo quitar la parada', err.response?.data?.error);
    }
  }

  async function reordenar(nuevasVisitas: Visita[]) {
    try {
      await api.patch(`/api/rutas/${id}/orden`, {
        secuencia: nuevasVisitas.map((v) => ({ tipo: v.tipoParada, id: v.id })),
      });
      cargar();
    } catch (err: any) {
      show('error', 'No se pudo reordenar', err.response?.data?.error);
    }
  }

  function mover(idx: number, direccion: -1 | 1) {
    const nuevo = [...visitas];
    const j = idx + direccion;
    if (j < 0 || j >= nuevo.length) return;
    [nuevo[idx], nuevo[j]] = [nuevo[j], nuevo[idx]];
    reordenar(nuevo);
  }

  async function asignarContenedor(viajeId: string, contenedorNumero: string) {
    if (!contenedorNumero) return;
    try {
      await api.patch(`/api/rutas/${id}/paradas/${viajeId}/contenedor`, { contenedor_numero: contenedorNumero });
      cargar();
    } catch (err: any) {
      show('error', 'No se pudo asignar el contenedor', err.response?.data?.error);
    }
  }

  async function confirmarRuta() {
    if (!confirm('¿Confirmar la ruta? Se reservan los contenedores y se avisa al chofer por WhatsApp.')) return;
    setConfirmando(true);
    try {
      await api.post(`/api/rutas/${id}/confirmar`);
      cargar();
      show('success', 'Ruta confirmada', 'Se avisó al chofer por WhatsApp.');
    } catch (err: any) {
      show('error', 'No se pudo confirmar', err.response?.data?.error || 'Error desconocido');
    } finally {
      setConfirmando(false);
    }
  }

  async function cambiarEstado(estado: string) {
    try {
      await api.patch(`/api/rutas/${id}`, { estado });
      cargar();
      show('success', 'Estado actualizado');
    } catch (err: any) {
      show('error', 'No se pudo actualizar el estado', err.response?.data?.error);
    }
  }

  if (!ruta) return null;

  return (
    <div>
      <div className="page-header">
        <Link to="/rutas" className="btn btn-ghost btn-sm" style={{ marginBottom: '8px' }}>
          <ArrowLeft size={13} strokeWidth={1.75} /> Volver a Rutas
        </Link>
        <h2>Ruta del {ruta.fecha} — {ruta.chofer_nombre ?? 'Sin chofer'}</h2>
        <p>Patente {ruta.patente ?? '—'} · {ruta.estado}</p>
      </div>

      <RoleGate roles={['admin', 'operador']}>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          <div className="form-card" style={{ flex: 1 }}>
            <div className="section-title">Cola sin rutear</div>
            {cola.length === 0 && <p className="text-muted">No hay pedidos sin rutear.</p>}
            {cola.map((v) => (
              <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <span className={`badge ${v.tipo === 'entrega' ? 'reservado' : 'retirado'}`}>{v.tipo}</span>
                  {v.grupo_id && (
                    <span title="Es parte de un recambio" style={{ marginLeft: '6px' }}>
                      <RefreshCw size={11} strokeWidth={2} style={{ color: 'var(--accent)' }} />
                    </span>
                  )}
                  {' '}
                  {v.contenedor_numero && <span className="mono">{v.contenedor_numero}</span>}
                  {' '}
                  <span className="text-muted">{v.destino_direccion ?? v.cliente_telefono ?? ''}</span>
                </div>
                {editable && (
                  <button className="btn btn-ghost btn-sm" onClick={() => agregarParada(v.id)} title="Agregar a esta ruta">
                    <Plus size={14} strokeWidth={2} />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="form-card" style={{ flex: 2 }}>
            <div className="section-title">Secuencia de la ruta</div>
            {visitas.length === 0 && <p className="text-muted">Todavía no hay paradas — agregá desde la cola de la izquierda.</p>}
            {visitas.map((v, idx) => (
              <div key={`${v.tipoParada}-${v.id}`} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <button className="btn btn-ghost btn-sm" disabled={idx === 0 || !editable} onClick={() => mover(idx, -1)}><ArrowUp size={12} strokeWidth={2} /></button>
                  <button className="btn btn-ghost btn-sm" disabled={idx === visitas.length - 1 || !editable} onClick={() => mover(idx, 1)}><ArrowDown size={12} strokeWidth={2} /></button>
                </div>
                <div className="text-muted mono" style={{ minWidth: '20px' }}>{idx + 1}</div>
                <div style={{ flex: 1 }}>
                  {v.vaciado && (
                    <div>
                      <span className="badge pendiente">Vaciado</span>{' '}
                      {v.vaciado.ubicacion_nombre ?? <span className="text-muted">Sin ubicación</span>}
                      {v.vaciado.notas && <div className="text-muted">{v.vaciado.notas}</div>}
                    </div>
                  )}
                  {v.entrega && v.retiro && (
                    <div>
                      <span className="badge reservado"><RefreshCw size={11} strokeWidth={2} /> Recambio</span>
                      <div>Lleno a retirar: <span className="mono">{v.retiro.contenedor_numero}</span></div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                        Vacío a dejar:
                        {editable ? (
                          <select
                            className="form-select"
                            style={{ padding: '4px 8px', fontSize: '0.85rem', width: 'auto' }}
                            value={v.entrega.contenedor_numero ?? ''}
                            onChange={(e) => asignarContenedor(v.entrega!.id, e.target.value)}
                          >
                            <option value="">— Elegir —</option>
                            {(v.entrega.disponibles ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        ) : (
                          <span className="mono">{v.entrega.contenedor_numero ?? '—'}</span>
                        )}
                      </div>
                      <div className="text-muted">{v.retiro.destino_direccion ?? v.entrega.destino_direccion}</div>
                    </div>
                  )}
                  {v.entrega && !v.retiro && (
                    <div>
                      <span className="badge reservado">entrega</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                        Contenedor:
                        {editable ? (
                          <select
                            className="form-select"
                            style={{ padding: '4px 8px', fontSize: '0.85rem', width: 'auto' }}
                            value={v.entrega.contenedor_numero ?? ''}
                            onChange={(e) => asignarContenedor(v.entrega!.id, e.target.value)}
                          >
                            <option value="">— Elegir —</option>
                            {(v.entrega.disponibles ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        ) : (
                          <span className="mono">{v.entrega.contenedor_numero ?? '—'}</span>
                        )}
                      </div>
                      <div className="text-muted">{v.entrega.destino_direccion}</div>
                    </div>
                  )}
                  {v.retiro && !v.entrega && (
                    <div>
                      <span className="badge retirado">retiro</span> <span className="mono">{v.retiro.contenedor_numero}</span>
                      <div className="text-muted">{v.retiro.destino_direccion}</div>
                    </div>
                  )}
                </div>
                {editable && (
                  <button className="btn btn-ghost btn-sm" onClick={() => quitarParada(v)} title="Quitar de la ruta">
                    <X size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            ))}

            {editable && (
              <div style={{ marginTop: '12px' }}>
                {agregandoVaciado ? (
                  <form onSubmit={agregarVaciado} className="form-row">
                    <div className="form-group">
                      <label className="form-label">Vaciadero</label>
                      <select className="form-select" value={vaciadoForm.ubicacion_id} onChange={(e) => setVaciadoForm({ ...vaciadoForm, ubicacion_id: e.target.value })}>
                        <option value="">— Elegir —</option>
                        {vaciaderos.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Notas</label>
                      <input className="form-input" value={vaciadoForm.notas} onChange={(e) => setVaciadoForm({ ...vaciadoForm, notas: e.target.value })} />
                    </div>
                    <button type="submit" className="btn btn-primary btn-sm">Agregar</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAgregandoVaciado(false)}>Cancelar</button>
                  </form>
                ) : (
                  <button className="btn btn-ghost btn-sm" onClick={() => setAgregandoVaciado(true)}>
                    <Plus size={14} strokeWidth={2} /> Agregar vaciado
                  </button>
                )}
              </div>
            )}

            {editable && visitas.length > 0 && (
              <div style={{ marginTop: '16px' }}>
                <button className="btn btn-success" onClick={confirmarRuta} disabled={confirmando}>
                  <CheckCircle2 size={16} strokeWidth={1.75} /> {confirmando ? 'Confirmando...' : 'Confirmar ruta'}
                </button>
              </div>
            )}

            <div style={{ marginTop: '16px' }}>
              <label className="form-label">Estado de la ruta</label>
              <select className="form-select" value={ruta.estado} onChange={(e) => cambiarEstado(e.target.value)} style={{ width: 'auto' }}>
                <option value="planificada">Planificada</option>
                <option value="en_curso">En curso</option>
                <option value="finalizada">Finalizada</option>
                <option value="cancelada">Cancelada</option>
              </select>
            </div>
          </div>
        </div>
      </RoleGate>
    </div>
  );
}
