import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowUp, ArrowDown, Plus, X, RefreshCw, CheckCircle2, Truck } from 'lucide-react';
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
  version: number;
  creado_en: string;
}
interface Chofer { id: string; nombre: string; activo: boolean; }
interface Contenedor { numero: string; estado: string; }
interface Ubicacion { id: string; tipo: 'deposito' | 'vaciadero'; nombre: string; activo: boolean; }

interface ViajePendiente {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  zona: string | null;
  contenedor_numero: string | null;
  destino_direccion: string | null;
  cliente_telefono: string | null;
  chofer_id?: string | null;
  ruta_id?: string | null;
  orden?: number | null;
  grupo_id: string | null;
  planificable?: boolean;
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
      const visita: VisitaPendiente = {
        id: v.id,
        fecha: v.fecha,
        zona: v.zona,
        destino_direccion: v.destino_direccion,
        cliente_telefono: v.cliente_telefono,
        chofer_id: v.chofer_id ?? null,
      };
      if (v.tipo === 'entrega') visita.entrega = v;
      if (v.tipo === 'retiro') visita.retiro = v;
      sueltas.push(visita);
      continue;
    }
    let visita = porGrupo.get(v.grupo_id);
    if (!visita) {
      visita = {
        id: v.grupo_id,
        fecha: v.fecha,
        zona: v.zona,
        destino_direccion: v.destino_direccion,
        cliente_telefono: v.cliente_telefono,
        chofer_id: v.chofer_id ?? null,
      };
      porGrupo.set(v.grupo_id, visita);
    }
    if (v.tipo === 'entrega') visita.entrega = v;
    if (v.tipo === 'retiro') visita.retiro = v;
  }
  return [...sueltas, ...porGrupo.values()];
}

interface StatsRuta { paradas: number; ent: number; ret: number; rec: number; warn: number; }
/** Resumen por ruta para las tarjetas — cuenta visitas (recambio = 1 sola) agrupando por `orden`. No incluye vaciados (viven en otra tabla), solo da una idea rápida antes de abrir el detalle. */
function statsPorRuta(viajesDia: ViajePendiente[]): Map<string, StatsRuta> {
  const porRuta = new Map<string, ViajePendiente[]>();
  for (const v of viajesDia) {
    if (!v.ruta_id) continue;
    const lista = porRuta.get(v.ruta_id) ?? [];
    lista.push(v);
    porRuta.set(v.ruta_id, lista);
  }
  const resultado = new Map<string, StatsRuta>();
  porRuta.forEach((viajes, rutaId) => {
    const porOrden = new Map<number, ViajePendiente[]>();
    for (const v of viajes) {
      const key = v.orden ?? 0;
      const lista = porOrden.get(key) ?? [];
      lista.push(v);
      porOrden.set(key, lista);
    }
    let ent = 0, ret = 0, rec = 0, warn = 0;
    porOrden.forEach((visita) => {
      const entrega = visita.find((v) => v.tipo === 'entrega');
      const retiro = visita.find((v) => v.tipo === 'retiro');
      if (entrega && retiro) { rec++; if (!entrega.contenedor_numero) warn++; }
      else if (entrega) { ent++; if (!entrega.contenedor_numero) warn++; }
      else if (retiro) { ret++; }
    });
    resultado.set(rutaId, { paradas: ent + ret + rec, ent, ret, rec, warn });
  });
  return resultado;
}

const ETIQUETA_ESTADO: Record<Ruta['estado'], { texto: string; clase: string }> = {
  planificada: { texto: 'Planificada', clase: 'programado' },
  en_curso: { texto: 'En curso', clase: 'en_curso' },
  finalizada: { texto: 'Finalizada', clase: 'completado' },
  cancelada: { texto: 'Cancelada', clase: 'cancelado' },
};

const iniciales = (nombre: string) => nombre.split(',')[0].slice(0, 2).toUpperCase();

// ── Detalle de una ruta (paradas, confirmación, vaciados) ─────────────────────

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

interface Advertencia { orden: number; tipo: 'lleno_sin_vaciar' | 'vacios_exceso'; mensaje: string; }

interface RutaData extends Ruta { paradas: Parada[]; advertencias: Advertencia[]; }

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

/**
  Simulación puramente visual de "qué contenedores están a bordo ahora
  mismo" (recorre toda la ruta ya armada). Es solo para el chip informativo
  de arriba del panel — la disponibilidad real que valida cada parada de
  entrega viene de `disponibles`, calculada por el backend.
 */
function simularAbordo(visitas: Visita[], disponiblesAlInicio: string[]): { disp: string[]; pend: string[] } {
  const disp = new Set(disponiblesAlInicio);
  const pend = new Set<string>();
  for (const v of visitas) {
    if (v.vaciado) { pend.forEach((c) => disp.add(c)); pend.clear(); continue; }
    if (v.retiro?.contenedor_numero) pend.add(v.retiro.contenedor_numero);
    if (v.entrega?.contenedor_numero) disp.delete(v.entrega.contenedor_numero);
  }
  return { disp: [...disp], pend: [...pend] };
}

function DetalleRuta({ rutaId, contenedoresDisponibles, rutasDelDia, choferes, onCambio }: {
  rutaId: string;
  contenedoresDisponibles: Contenedor[];
  rutasDelDia: Ruta[];
  choferes: Chofer[];
  onCambio: () => void;
}) {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [agregandoVaciado, setAgregandoVaciado] = useState(false);
  const [vaciadoForm, setVaciadoForm] = useState({ ubicacion_id: '', notas: '' });
  const [confirmando, setConfirmando] = useState(false);

  const { data: ruta } = useQuery({
    queryKey: ['rutas', rutaId],
    queryFn: () => api.get<RutaData>(`/api/rutas/${rutaId}`).then((r) => r.data),
  });
  const { data: ubicaciones = [] } = useQuery({
    queryKey: ['ubicaciones'],
    queryFn: () => api.get<Ubicacion[]>('/api/ubicaciones').then((r) => r.data.filter((u) => u.activo)),
  });
  const vaciaderos = ubicaciones.filter((u) => u.tipo === 'vaciadero');

  const cargar = () => {
    queryClient.invalidateQueries({ queryKey: ['rutas', rutaId] });
    onCambio();
  };

  const visitas = ruta ? agruparVisitas(ruta.paradas) : [];
  const editable = ruta?.estado === 'planificada' || ruta?.estado === 'en_curso';
  const abordo = simularAbordo(visitas, contenedoresDisponibles.map((c) => c.numero));

  async function agregarVaciado(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/api/rutas/${rutaId}/paradas/vaciado`, {
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
    if (!confirm('¿Quitar esta parada de la ruta? Vuelve a la bolsa de pedidos.')) return;
    try {
      await api.delete(`/api/rutas/${rutaId}/paradas/${v.tipoParada}/${v.id}`);
      cargar();
    } catch (err: any) {
      show('error', 'No se pudo quitar la parada', err.response?.data?.error);
    }
  }

  async function moverParadaA(tipo: 'viaje' | 'vaciado', paradaId: string, choferId: string) {
    let rutaDestino = rutasDelDia.find((r) => r.chofer_id === choferId);
    if (!rutaDestino) {
      try {
        const res = await api.post<Ruta>('/api/rutas', { fecha: ruta?.fecha, chofer_id: choferId });
        rutaDestino = res.data;
      } catch (err: any) {
        show('error', 'No se pudo crear la ruta de destino', err.response?.data?.error);
        return;
      }
    }
    try {
      await api.post(`/api/rutas/${rutaId}/paradas/${tipo}/${paradaId}/mover`, { ruta_destino_id: rutaDestino.id });
      const nombreDestino = choferes.find((c) => c.id === choferId)?.nombre ?? 'chofer';
      show('success', 'Parada movida', `Se movió la parada a la ruta de ${nombreDestino}.`);
      cargar();
    } catch (err: any) {
      show('error', 'No se pudo mover la parada', err.response?.data?.error);
    }
  }

  async function reordenar(nuevasVisitas: Visita[]) {
    try {
      await api.patch(`/api/rutas/${rutaId}/orden`, {
        secuencia: nuevasVisitas.map((v) => ({ tipo: v.tipoParada, id: v.id })),
        version: ruta?.version,
      });
      cargar();
    } catch (err: any) {
      if (err.response?.status === 409) {
        show('error', 'Esta ruta cambió', 'Otro usuario la modificó mientras tanto — se recargó con los cambios de él.');
        cargar();
        return;
      }
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
      await api.patch(`/api/rutas/${rutaId}/paradas/${viajeId}/contenedor`, { contenedor_numero: contenedorNumero });
      cargar();
    } catch (err: any) {
      show('error', 'No se pudo asignar el contenedor', err.response?.data?.error);
    }
  }

  async function confirmarRuta() {
    if (!confirm('¿Confirmar la ruta? Se reservan las paradas nuevas y se avisa al chofer por WhatsApp. Podés volver a confirmar más tarde si entra trabajo nuevo.')) return;
    setConfirmando(true);
    try {
      const { data } = await api.post<{ confirmadas: number; pendientes: string[] }>(`/api/rutas/${rutaId}/confirmar`);
      cargar();
      if (data.pendientes.length > 0) {
        show(
          'error',
          `${data.confirmadas} parada(s) confirmada(s), ${data.pendientes.length} pendiente(s)`,
          data.pendientes.join(' · '),
        );
      } else if (data.confirmadas > 0) {
        show('success', `${data.confirmadas} parada(s) confirmada(s)`, 'Se avisó al chofer por WhatsApp.');
      } else {
        show('success', 'Ya estaba todo confirmado', 'No había paradas nuevas para reservar.');
      }
    } catch (err: any) {
      show('error', 'No se pudo confirmar', err.response?.data?.error || 'Error desconocido');
    } finally {
      setConfirmando(false);
    }
  }

  async function cambiarEstado(estado: string) {
    try {
      await api.patch(`/api/rutas/${rutaId}`, { estado });
      cargar();
      show('success', 'Estado actualizado');
    } catch (err: any) {
      show('error', 'No se pudo actualizar el estado', err.response?.data?.error);
    }
  }

  if (!ruta) return null;

  const estado = ETIQUETA_ESTADO[ruta.estado];
  let invalid = 0;
  for (const v of visitas) {
    if (v.entrega && !v.entrega.contenedor_numero) invalid++;
    else if (v.entrega?.contenedor_numero && !(v.entrega.disponibles ?? []).includes(v.entrega.contenedor_numero)) invalid++;
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <div className="t">{ruta.chofer_nombre ?? 'Sin chofer'}</div>
          <div className="s">Patente {ruta.patente ?? '—'} · {ruta.fecha}</div>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <select className="form-select" style={{ width: 'auto', fontSize: '0.8rem' }} value={ruta.estado} onChange={(e) => cambiarEstado(e.target.value)}>
            <option value="planificada">Planificada</option>
            <option value="en_curso">En curso</option>
            <option value="finalizada">Finalizada</option>
            <option value="cancelada">Cancelada</option>
          </select>
          <span className={`badge ${estado.clase}`}>{estado.texto}</span>
        </div>
      </div>

      <RoleGate roles={['admin', 'operador']}>
        <div style={{ padding: '16px 18px' }}>
          <div className="abordo-label" style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
            Stock simulado a bordo:
          </div>
          <div className="abordo">
            {abordo.disp.length === 0 && abordo.pend.length === 0 && <span className="cchip none">nada a bordo todavía</span>}
            {abordo.disp.map((c) => <span key={c} className="cchip">{c}</span>)}
            {abordo.pend.map((c) => <span key={c} className="cchip pend">{c} · sin vaciar</span>)}
          </div>

          {ruta.advertencias.length > 0 && (
            <div className="rc-warn" style={{ marginTop: '10px', marginBottom: '8px', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', background: 'var(--warning-bg)', padding: '8px 12px', borderRadius: 'var(--radius)' }}>
              {ruta.advertencias.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <AlertTriangle size={14} strokeWidth={2} /> {a.mensaje}
                </div>
              ))}
            </div>
          )}

          {visitas.length === 0 && <div className="rc-empty" style={{ margin: '16px 0' }}>Todavía no hay paradas en esta ruta — asigná desde la bolsa a la izquierda.</div>}
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            {visitas.map((v, idx) => {
              const disponibles = v.entrega?.disponibles ?? [];
              const necesitaContenedor = !!v.entrega;
              const sinAsignar = necesitaContenedor && !v.entrega!.contenedor_numero;
              const invalido = necesitaContenedor && !!v.entrega!.contenedor_numero && !disponibles.includes(v.entrega!.contenedor_numero!);
              return (
                <div key={`${v.tipoParada}-${v.id}`} className="stop">
                  <div className="stop-ord">{idx + 1}</div>
                  <div className="stop-body">
                    {v.vaciado && (
                      <>
                        <div className="stop-top">
                          <div className="stop-cli">{v.vaciado.ubicacion_nombre ?? 'Depósito / vaciadero'}</div>
                          <span className="tag vaciado">Vaciado</span>
                        </div>
                        {v.vaciado.notas && <div className="stop-sub">{v.vaciado.notas}</div>}
                      </>
                    )}
                    {v.entrega && v.retiro && (
                      <>
                        <div className="stop-top">
                          <div className="stop-cli">{v.retiro.destino_direccion ?? v.entrega.destino_direccion}</div>
                          <span className="tag recambio"><RefreshCw size={11} strokeWidth={2} /> Recambio</span>
                        </div>
                        <div className="stop-sub">Lleno a retirar: {v.retiro.contenedor_numero}</div>
                        <div className="sel-row">
                          <label>Vacío a dejar:</label>
                          {editable ? (
                            <select
                              className={`form-select${(sinAsignar || invalido) ? ' err' : ''}`}
                              value={v.entrega.contenedor_numero ?? ''}
                              onChange={(e) => asignarContenedor(v.entrega!.id, e.target.value)}
                            >
                              <option value="">— elegir —</option>
                              {disponibles.map((c) => <option key={c} value={c}>{c}</option>)}
                              {invalido && <option value={v.entrega.contenedor_numero!}>{v.entrega.contenedor_numero} (ya no disp.)</option>}
                            </select>
                          ) : (
                            <span className="mono">{v.entrega.contenedor_numero ?? '—'}</span>
                          )}
                          {sinAsignar && disponibles.length === 0 && <span className="sel-warn">sin stock a bordo</span>}
                        </div>
                      </>
                    )}
                    {v.entrega && !v.retiro && (
                      <>
                        <div className="stop-top">
                          <div className="stop-cli">{v.entrega.destino_direccion ?? '—'}</div>
                          <span className="tag entrega">Entrega</span>
                        </div>
                        <div className="sel-row">
                          <label>Contenedor:</label>
                          {editable ? (
                            <select
                              className={`form-select${(sinAsignar || invalido) ? ' err' : ''}`}
                              value={v.entrega.contenedor_numero ?? ''}
                              onChange={(e) => asignarContenedor(v.entrega!.id, e.target.value)}
                            >
                              <option value="">— elegir —</option>
                              {disponibles.map((c) => <option key={c} value={c}>{c}</option>)}
                              {invalido && <option value={v.entrega.contenedor_numero!}>{v.entrega.contenedor_numero} (ya no disp.)</option>}
                            </select>
                          ) : (
                            <span className="mono">{v.entrega.contenedor_numero ?? '—'}</span>
                          )}
                          {sinAsignar && disponibles.length === 0 && <span className="sel-warn">sin stock a bordo</span>}
                        </div>
                      </>
                    )}
                    {v.retiro && !v.entrega && (
                      <>
                        <div className="stop-top">
                          <div className="stop-cli">{v.retiro.destino_direccion ?? '—'}</div>
                          <span className="tag retiro">Retiro</span>
                        </div>
                        <div className="stop-sub">{v.retiro.contenedor_numero}</div>
                      </>
                    )}
                  </div>

                  <div className="arrows">
                    <button disabled={idx === 0 || !editable} onClick={() => mover(idx, -1)} title="Subir orden"><ArrowUp size={12} strokeWidth={2} /></button>
                    <button disabled={idx === visitas.length - 1 || !editable} onClick={() => mover(idx, 1)} title="Bajar orden"><ArrowDown size={12} strokeWidth={2} /></button>
                  </div>

                  {editable && (
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginLeft: '6px' }}>
                      <select
                        className="form-select"
                        style={{ fontSize: '0.72rem', padding: '2px 6px', width: '110px' }}
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value) {
                            moverParadaA(v.tipoParada, v.id, e.target.value);
                            e.target.value = '';
                          }
                        }}
                        title="Reasignar parada a otro chofer"
                      >
                        <option value="" disabled>Mover a...</option>
                        {choferes.filter((c) => c.id !== ruta.chofer_id).map((c) => (
                          <option key={c.id} value={c.id}>{c.nombre}</option>
                        ))}
                      </select>
                      <button className="addbtn" onClick={() => quitarParada(v)} title="Quitar de la ruta"><X size={13} strokeWidth={2} /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {editable && (
            <div style={{ marginTop: '14px' }}>
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
                <button className="btn btn-ghost" onClick={() => setAgregandoVaciado(true)}>
                  <Plus size={14} strokeWidth={2} /> Agregar vaciado
                </button>
              )}
            </div>
          )}
        </div>

        <div className="detail-foot">
          <span className="valid-msg" style={{ color: invalid ? 'var(--danger)' : 'var(--success)' }}>
            {visitas.length === 0 ? '' : invalid ? `${invalid} parada(s) sin contenedor válido` : '✓ todas las paradas resueltas'}
          </span>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {editable && visitas.length > 0 && (
              <button className="btn btn-primary" onClick={confirmarRuta} disabled={confirmando}>
                <CheckCircle2 size={16} strokeWidth={1.75} /> {confirmando ? 'Confirmando...' : 'Confirmar ruta'}
              </button>
            )}
          </div>
        </div>
      </RoleGate>
    </div>
  );
}

// ── Página principal: layout 2 columnas (Bolsa a la izquierda, Choferes a la derecha) ────

export function Rutas() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [rutaSeleccionada, setRutaSeleccionada] = useState<string | null>(null);

  const { data: choferes = [] } = useQuery({
    queryKey: ['choferes', 'activos'],
    queryFn: () => api.get<Chofer[]>('/api/choferes').then((r) => r.data.filter((c) => c.activo)),
  });
  const { data: rutas = [] } = useQuery({
    queryKey: ['rutas', fecha],
    queryFn: () => api.get<Ruta[]>(`/api/rutas?fecha=${fecha}`).then((r) => r.data),
  });
  const { data: cola = [] } = useQuery({
    queryKey: ['rutas', 'bolsa'],
    queryFn: () => api.get<ViajePendiente[]>('/api/rutas/bolsa').then((r) => r.data),
    refetchInterval: 15000,
  });
  const { data: viajesDelDia = [] } = useQuery({
    queryKey: ['viajes', 'del-dia', fecha],
    queryFn: () => api.get<ViajePendiente[]>(`/api/viajes?fecha=${fecha}&estado=programado`).then((r) => r.data),
  });
  const { data: contenedoresDisponibles = [] } = useQuery({
    queryKey: ['contenedores', 'disponibles'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data.filter((c) => c.estado === 'disponible')),
  });

  const visitasPendientes = agruparPendientes(cola);
  const statsRutas = statsPorRuta(viajesDelDia);
  const visitasDelDia = agruparPendientes(viajesDelDia).length;
  const ruteados = agruparPendientes(viajesDelDia.filter((v) => v.ruta_id)).length;

  // Agrupamiento por zona de los pedidos sin rutear
  const visitasPorZona = (() => {
    const map = new Map<string, VisitaPendiente[]>();
    for (const v of visitasPendientes) {
      const zona = v.zona ?? (v.destino_direccion ? v.destino_direccion.split(',')[0] : 'Sin zona');
      const lista = map.get(zona) ?? [];
      lista.push(v);
      map.set(zona, lista);
    }
    return map;
  })();

  // Selecciona la primera ruta del día automáticamente cuando cambia la fecha o cargan los datos.
  useEffect(() => {
    if (rutas.length === 0) { setRutaSeleccionada(null); return; }
    if (!rutas.some((r) => r.id === rutaSeleccionada)) setRutaSeleccionada(rutas[0].id);
  }, [rutas, rutaSeleccionada]);

  const recargarListas = () => {
    queryClient.invalidateQueries({ queryKey: ['rutas', fecha] });
    queryClient.invalidateQueries({ queryKey: ['rutas', 'bolsa'] });
    queryClient.invalidateQueries({ queryKey: ['viajes', 'del-dia', fecha] });
  };

  async function armarRuta(choferId: string) {
    try {
      const { data } = await api.post<Ruta>('/api/rutas', { fecha, chofer_id: choferId });
      recargarListas();
      setRutaSeleccionada(data.id);
    } catch (err: any) {
      show('error', 'No se pudo crear la ruta', err.response?.data?.error);
    }
  }

  async function asignarAChofer(visita: VisitaPendiente, choferId: string) {
    if (!choferId) return;
    try {
      let ruta = rutas.find((r) => r.chofer_id === choferId);
      if (!ruta) {
        const res = await api.post<Ruta>('/api/rutas', { fecha, chofer_id: choferId });
        ruta = res.data;
      }
      const viajeId = visita.entrega?.id ?? visita.retiro?.id ?? visita.id;
      await api.post(`/api/rutas/${ruta.id}/paradas`, { viaje_id: viajeId });
      const nombreChofer = choferes.find((c) => c.id === choferId)?.nombre ?? 'chofer';
      show('success', 'Pedido asignado', `Asignado a la ruta de ${nombreChofer}.`);
      setRutaSeleccionada(ruta.id);
      recargarListas();
    } catch (err: any) {
      show('error', 'No se pudo asignar el pedido', err.response?.data?.error || 'Error desconocido');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Rutas</h2>
          <p>Planificá el recorrido de cada chofer.</p>
        </div>
        <div className="date-pick">Día: <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></div>
      </div>

      <div className="stats">
        <div className="stat"><div className="l">Pedidos del día</div><div className="n">{visitasDelDia}</div></div>
        <div className="stat"><div className="l">Ruteados</div><div className="n">{ruteados}</div></div>
        <div className="stat"><div className="l">Sin asignar</div><div className={`n${visitasPendientes.length ? ' warn' : ''}`}>{visitasPendientes.length}</div></div>
        <div className="stat"><div className="l">Choferes activos</div><div className="n">{choferes.length}</div></div>
      </div>

      {/* Grid principal en 2 columnas: Bolsa (Izquierda) | Choferes y Detalle (Derecha) */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '20px', alignItems: 'start' }}>
        
        {/* COLUMNA IZQUIERDA: Bolsa de pedidos sin rutear */}
        <div className="card" style={{ padding: '16px 18px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', borderBottom: '1px solid var(--border)', paddingBottom: '10px' }}>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>📦 Pedidos sin rutear</span>
            </div>
            <span className="badge programado" style={{ fontSize: '0.75rem' }}>{visitasPendientes.length}</span>
          </div>

          {visitasPendientes.length === 0 ? (
            <div className="rc-empty" style={{ textAlign: 'center', padding: '20px 0' }}>No hay pedidos pendientes en la bolsa.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxHeight: 'calc(100vh - 240px)', overflowY: 'auto', paddingRight: '4px' }}>
              {[...visitasPorZona.entries()].map(([zona, items]) => (
                <div key={zona} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--bg-surface)', padding: '4px 8px', borderRadius: 'var(--radius-sm)' }}>
                    📍 {zona} ({items.length})
                  </div>
                  {items.map((visita) => (
                    <div key={visita.id} className="qrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px', padding: '10px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div className="cli" style={{ fontSize: '0.82rem', fontWeight: 600 }}>{visita.destino_direccion ?? 'Sin dirección'}</div>
                          <div className="sub" style={{ fontSize: '0.73rem', color: 'var(--text-muted)' }}>
                            {visita.entrega && visita.retiro ? 'Recambio' : visita.entrega ? 'Entrega' : 'Retiro'}
                            {visita.cliente_telefono ? ` · 📞 ${visita.cliente_telefono}` : ''}
                          </div>
                        </div>
                        <span className={`tag ${visita.entrega && visita.retiro ? 'recambio' : visita.entrega ? 'entrega' : 'retiro'}`} style={{ fontSize: '0.68rem', padding: '2px 6px' }}>
                          {visita.entrega && visita.retiro ? 'Recambio' : visita.entrega ? 'Entrega' : 'Retiro'}
                        </span>
                      </div>

                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px' }}>
                        <select
                          className="form-select"
                          style={{ fontSize: '0.76rem', padding: '4px 8px', width: '100%' }}
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) {
                              asignarAChofer(visita, e.target.value);
                              e.target.value = '';
                            }
                          }}
                        >
                          <option value="" disabled>+ Asignar a chofer...</option>
                          {choferes.map((c) => (
                            <option key={c.id} value={c.id}>{c.nombre}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* COLUMNA DERECHA: Rutas por Chofer + Detalle de Ruta */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <div className="section-title" style={{ marginBottom: '10px', fontSize: '0.9rem', fontWeight: 700 }}>
              Choferes y Rutas del Día
            </div>
            <div className="routes-grid">
              {choferes.map((chofer) => {
                const ruta = rutas.find((r) => r.chofer_id === chofer.id);
                if (!ruta) {
                  return (
                    <button key={chofer.id} className="route-card" onClick={() => armarRuta(chofer.id)}>
                      <div className="rc-head">
                        <div className="rc-av">{iniciales(chofer.nombre)}</div>
                        <div><div className="rc-nm">{chofer.nombre}</div><div className="rc-pat">—</div></div>
                        <span className="badge vacia">Vacía</span>
                      </div>
                      <div className="rc-lines">
                        <div className="rc-empty">Sin ruta armada</div>
                        <div className="rc-cta">+ Armar ruta</div>
                      </div>
                    </button>
                  );
                }
                const stats = statsRutas.get(ruta.id) ?? { paradas: 0, ent: 0, ret: 0, rec: 0, warn: 0 };
                const estado = ETIQUETA_ESTADO[ruta.estado];
                const sel = ruta.id === rutaSeleccionada;
                return (
                  <button
                    key={chofer.id}
                    className={`route-card${sel ? ' sel' : ''}${stats.warn ? ' warn' : ''}`}
                    onClick={() => setRutaSeleccionada(ruta.id)}
                  >
                    <div className="rc-head">
                      <div className="rc-av">{iniciales(chofer.nombre)}</div>
                      <div><div className="rc-nm">{chofer.nombre}</div><div className="rc-pat">{ruta.patente ?? '—'}</div></div>
                      <span className={`badge ${estado.clase}`}>{estado.texto}</span>
                    </div>
                    <div className="rc-lines">
                      <div className="rc-line"><span>Paradas</span><span className="v">{stats.paradas}</span></div>
                      <div className="rc-line"><span>Ent · ret · rec</span><span className="v">{stats.ent} · {stats.ret} · {stats.rec}</span></div>
                      {stats.warn > 0 && (
                        <div className="rc-warn"><AlertTriangle size={13} strokeWidth={2} /> {stats.warn} parada{stats.warn > 1 ? 's' : ''} sin contenedor</div>
                      )}
                      <div className="rc-cta">{sel ? 'Editando ahora ↓' : 'Abrir y editar →'}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {rutaSeleccionada ? (
            <div>
              <div className="section-title" style={{ marginBottom: '10px', fontSize: '0.9rem', fontWeight: 700 }}>
                Detalle y Armado de Ruta
              </div>
              <DetalleRuta
                rutaId={rutaSeleccionada}
                contenedoresDisponibles={contenedoresDisponibles}
                rutasDelDia={rutas}
                choferes={choferes}
                onCambio={recargarListas}
              />
            </div>
          ) : (
            <div className="card empty-state" style={{ padding: '40px 20px' }}>
              <div className="empty-state-title">Ninguna ruta seleccionada</div>
              <div className="empty-state-text">Hacé clic en un chofer arriba para ver y armar su ruta, o asignale pedidos directamente desde la bolsa a la izquierda.</div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
