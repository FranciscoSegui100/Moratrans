import { useMemo, useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpFromLine, ArrowDownToLine, RefreshCw, X, Plus, MapPin, Printer, FileText, Ban } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { DireccionMaps } from '../components/DireccionMaps';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { formatearFecha } from '../lib/fechas';
import { hoyISO, sumarDias, fechaEnRango } from '../lib/viajes';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface Comprobante {
  id: string;
  tipo: string;
  monto: string | null;
  estado: string;
  es_cuenta_corriente: boolean;
  tiene_comprobante: boolean;
  titular: string | null;
  creado_en: string;
}
interface Viaje {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  estado: string;
  zona: string | null;
  contenedor_numero: string | null;
  contenedor_estado: string | null;
  destino_direccion: string | null;
  destino_lat: string | null;
  destino_lng: string | null;
  horario_preferido: string | null;
  hora_estimada: string | null;
  cliente_telefono: string | null;
  chofer_nombre: string | null;
  chofer_id: string | null;
  patente: string | null;
  grupo_id: string | null;
  remito: string | null;
  importe: string | null;
  notas: string | null;
  ubicacion_id: string | null;
  ubicacion_direccion: string | null;
  origen_direccion: string | null;
  destino_final_direccion: string | null;
  es_cuenta_corriente: boolean;
  pago_id: string | null;
  ruta_id: string | null;
  orden: number | null;
  ruta_confirmada_en: string | null;
  completada_en: string | null;
  tiene_foto_entrega?: boolean;
  comprobantes: Comprobante[];
}
interface Contenedor { numero: string; estado: string; vence_en: string | null; }
interface Tarifa { departamento: string; activo: boolean; }
interface Chofer { id: string; nombre: string; activo: boolean; }

const ETIQUETAS_ESTADO_CONTENEDOR: Record<string, string> = {
  disponible: 'Disponible',
  alquilado: 'Alquilado',
  para_retirar: 'Para retirar',
  yendo_a_vaciar: 'Yendo a vaciar',
  vencido: 'Vencido',
};

type PestanaViajes = 'activos' | 'historial';
type PresetRango = 'hoy' | 'manana' | 'semana' | 'todo' | 'custom';
/** Un recambio son dos filas con grupo_id: para el filtro de tipo cuenta como su propia categoría. */
const categoriaTipo = (v: Viaje): 'entrega' | 'retiro' | 'recambio' => (v.grupo_id ? 'recambio' : v.tipo);

/** Mismo criterio que el badge de la columna "Ruta" — para poder filtrar por lo mismo que ya se ve. */
type EstadoRuteo = 'bolsa' | 'planificada' | 'confirmada' | 'en_ruta';
function estadoRuteo(v: Viaje): EstadoRuteo {
  if (!v.ruta_id) return 'bolsa';
  if (v.completada_en) return 'en_ruta';
  if (v.ruta_confirmada_en) return 'confirmada';
  return 'planificada';
}
const ETIQUETAS_ESTADO_RUTEO: Record<EstadoRuteo, string> = {
  bolsa: 'Bolsa (sin rutear)', planificada: 'Planificada', confirmada: 'Confirmada', en_ruta: '✓ En ruta',
};

const PRESETS: { id: PresetRango; label: string }[] = [
  { id: 'hoy', label: 'Hoy' },
  { id: 'manana', label: 'Mañana' },
  { id: 'semana', label: 'Semana' },
  { id: 'todo', label: 'Todo' },
];

export function Viajes() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const fechaUrl = searchParams.get('fecha');

  const [asignando, setAsignando] = useState<string | null>(null);
  const [asignarContenedorNumero, setAsignarContenedorNumero] = useState('');
  const [pestana, setPestana] = useState<PestanaViajes>('activos');
  const [viajeComprobantes, setViajeComprobantes] = useState<Viaje | null>(null);
  const [viajeFotoEntrega, setViajeFotoEntrega] = useState<Viaje | null>(null);
  const [remitoImprimir, setRemitoImprimir] = useState<Viaje | null>(null);

  useEscapeKey(() => setViajeComprobantes(null), viajeComprobantes !== null);
  useEscapeKey(() => setViajeFotoEntrega(null), viajeFotoEntrega !== null);
  useEscapeKey(() => setRemitoImprimir(null), remitoImprimir !== null);

  const [preset, setPreset] = useState<PresetRango>(() => (fechaUrl ? 'custom' : 'semana'));
  const [customDesde, setCustomDesde] = useState(() => fechaUrl || hoyISO());
  const [customHasta, setCustomHasta] = useState(() => fechaUrl || sumarDias(hoyISO(), 6));
  const [filtroZona, setFiltroZona] = useState('');
  const [filtroTipo, setFiltroTipo] = useState<'' | 'entrega' | 'retiro' | 'recambio'>('');
  const [filtroChofer, setFiltroChofer] = useState('');
  const [filtroRuteo, setFiltroRuteo] = useState<'' | EstadoRuteo>('');

  useEffect(() => {
    if (fechaUrl) {
      setPreset('custom');
      setCustomDesde(fechaUrl);
      setCustomHasta(fechaUrl);
    }
  }, [fechaUrl]);

  const { data: viajes = [] } = useQuery({
    queryKey: ['viajes'],
    queryFn: () => api.get<Viaje[]>('/api/viajes').then((r) => r.data),
    refetchInterval: 10_000,
  });
  const { data: contenedores = [] } = useQuery({
    queryKey: ['contenedores'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data),
  });

  // El contenedor de cualquier viaje (incluido el lleno de un recambio) ya no
  // se pide al programarlo desde Rutas: se asigna después, con el botón
  // "Asignar" de la columna Contenedor de esta tabla — retiro ofrece los
  // contenedores "entregado" (llenos), entrega los "disponible" (vacíos).
  const contenedoresEntregados = contenedores.filter((c) => c.estado === 'entregado');
  const vaciosDisponibles = contenedores.filter((c) => c.estado === 'disponible');

  const { data: zonas = [] } = useQuery({
    queryKey: ['tarifas', 'activas'],
    queryFn: () => api.get<Tarifa[]>('/api/tarifas').then((r) => r.data.filter((t) => t.activo)),
  });
  const { data: choferes = [] } = useQuery({
    queryKey: ['choferes', 'activos'],
    queryFn: () => api.get<Chofer[]>('/api/choferes').then((r) => r.data.filter((c) => c.activo)),
  });
  const cargar = () => queryClient.invalidateQueries({ queryKey: ['viajes'] });

  const { desde, hasta } = useMemo(() => {
    const hoy = hoyISO();
    switch (preset) {
      case 'hoy': return { desde: hoy, hasta: hoy };
      case 'manana': { const m = sumarDias(hoy, 1); return { desde: m, hasta: m }; }
      case 'semana': return { desde: hoy, hasta: sumarDias(hoy, 6) };
      case 'todo': return { desde: '0000-01-01', hasta: '9999-12-31' };
      case 'custom': return { desde: customDesde, hasta: customHasta };
    }
  }, [preset, customDesde, customHasta]);

  const viajesEnRango = useMemo(
    () => viajes.filter((v) =>
      fechaEnRango(v.fecha, desde, hasta)
      && (!filtroZona || v.zona === filtroZona)
      && (!filtroTipo || categoriaTipo(v) === filtroTipo)
      && (!filtroChofer || v.chofer_id === filtroChofer)
      && (!filtroRuteo || estadoRuteo(v) === filtroRuteo),
    ),
    [viajes, desde, hasta, filtroZona, filtroTipo, filtroChofer, filtroRuteo],
  );

  /**
   * Completa la fila 'entrega' de un recambio (se crea sin contenedor, ver
   * recambio.flow.ts). Solo el contenedor: el chofer ya no se elige desde
   * Viajes, sale de la ruta en la que se arme el viaje (pestaña Rutas).
   */
  async function asignarContenedor(id: string) {
    if (!asignarContenedorNumero) return;
    try {
      await api.patch(`/api/viajes/${id}`, { contenedor_numero: asignarContenedorNumero });
      setAsignando(null);
      setAsignarContenedorNumero('');
      cargar();
      show('success', 'Contenedor asignado');
    } catch (err: any) {
      show('error', 'No se pudo asignar', err.response?.data?.error);
    }
  }

  async function cambiarRemito(id: string, remito: string) {
    try {
      await api.patch(`/api/viajes/${id}`, { remito: remito.trim() || null });
      cargar();
      show('success', 'Nº de remito actualizado');
    } catch (err: any) {
      show('error', 'No se pudo guardar el remito', err.response?.data?.error);
    }
  }

  async function cancelarViaje(id: string) {
    if (!confirm('¿Seguro que deseás cancelar este viaje? Si tiene un contenedor asignado o reservado, quedará liberado.')) return;
    try {
      await api.patch(`/api/viajes/${id}`, { estado: 'cancelado' });
      cargar();
      show('info', 'Viaje cancelado');
    } catch (err: any) {
      show('error', 'No se pudo cancelar el viaje', err.response?.data?.error);
    }
  }

  const viajesActivos = viajesEnRango.filter((v) => v.estado === 'programado' || v.estado === 'en_curso');
  const viajesHistorial = viajesEnRango.filter((v) => v.estado === 'completado' || v.estado === 'cancelado');
  const viajesAMostrar = pestana === 'activos' ? viajesActivos : viajesHistorial;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Viajes</h2>
          <p>Gestión operativa de entregas, retiros e historial de viajes</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <RoleGate roles={['admin', 'operador']}>
            <Link
              to="/rutas?nuevo=1"
              className="btn btn-primary btn-sm"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Plus size={14} strokeWidth={2} /> Programar viaje
            </Link>
          </RoleGate>
          <Link
            to={`/rutas?fecha=${customDesde}`}
            className="btn btn-ghost btn-sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            title="Ir a planificar rutas para esta fecha"
          >
            <MapPin size={14} strokeWidth={2} /> Ver en Rutas
          </Link>
        </div>
      </div>

      {/* Barra de filtros */}
      <div className="viajes-toolbar">
        <div className="viajes-filtros">
          <div className="btn-group">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className={`btn btn-sm ${preset === p.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
            <button
              className={`btn btn-sm ${preset === 'custom' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setPreset('custom')}
            >
              Rango
            </button>
          </div>
          {preset === 'custom' && (
            <div className="viajes-rango-custom">
              <input type="date" className="form-input" value={customDesde} onChange={(e) => setCustomDesde(e.target.value)} />
              <span>a</span>
              <input type="date" className="form-input" value={customHasta} onChange={(e) => setCustomHasta(e.target.value)} />
            </div>
          )}
          <select className="form-select" style={{ width: 'auto' }} value={filtroZona} onChange={(e) => setFiltroZona(e.target.value)}>
            <option value="">Todas las zonas</option>
            {zonas.map((z) => <option key={z.departamento} value={z.departamento}>{z.departamento}</option>)}
          </select>
          <select className="form-select" style={{ width: 'auto' }} value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value as any)}>
            <option value="">Todos los tipos</option>
            <option value="entrega">Entregas</option>
            <option value="retiro">Retiros</option>
            <option value="recambio">Recambios</option>
          </select>
          <select className="form-select" style={{ width: 'auto' }} value={filtroChofer} onChange={(e) => setFiltroChofer(e.target.value)}>
            <option value="">Todos los choferes</option>
            {choferes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
          <select className="form-select" style={{ width: 'auto' }} value={filtroRuteo} onChange={(e) => setFiltroRuteo(e.target.value as any)}>
            <option value="">Cualquier estado de ruteo</option>
            {(Object.keys(ETIQUETAS_ESTADO_RUTEO) as EstadoRuteo[]).map((k) => <option key={k} value={k}>{ETIQUETAS_ESTADO_RUTEO[k]}</option>)}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <button
          className={`btn btn-sm ${pestana === 'activos' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setPestana('activos')}
        >
          Activos / Programados ({viajesActivos.length})
        </button>
        <button
          className={`btn btn-sm ${pestana === 'historial' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setPestana('historial')}
        >
          Historial de realizados ({viajesHistorial.length})
        </button>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Horario sugerido</th>
              <th>Tipo</th>
              <th>Zona</th>
              <th>Origen</th>
              <th>Destino</th>
              <th>Contenedor</th>
              <th>Estado contenedor</th>
              <th>Chofer</th>
              <th>Patente</th>
              <th>Nº remito</th>
              <th>Importe</th>
              <th>Ruta</th>
              <th>Comprobantes</th>
              <th style={{ width: '40px' }} />
            </tr>
          </thead>
          <tbody>
            {viajesAMostrar.map((v) => (
              <tr key={v.id}>
                <td className="strong" style={{ whiteSpace: 'nowrap' }}>{formatearFecha(v.fecha)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {v.horario_preferido ? (
                    // El texto ya trae su propio emoji (🌅/🕐), no anteponer otro.
                    <span title="Franja horaria preferida (la pidió el cliente por WhatsApp o la cargó el operador)">{v.horario_preferido}</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
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
                <td style={{ maxWidth: '160px', whiteSpace: 'normal' }}>
                  {/* La dirección del cliente (con lat/lng, si vino de un GPS de WhatsApp) es
                      origen en un retiro y destino en una entrega — v.destino_lat/lng siempre
                      corresponden a v.destino_direccion, nunca a la ubicación propia. */}
                  <DireccionMaps direccion={v.origen_direccion} lat={v.tipo === 'retiro' ? v.destino_lat : null} lng={v.tipo === 'retiro' ? v.destino_lng : null} />
                </td>
                <td style={{ maxWidth: '160px', whiteSpace: 'normal' }}>
                  <DireccionMaps direccion={v.destino_final_direccion} lat={v.tipo === 'entrega' ? v.destino_lat : null} lng={v.tipo === 'entrega' ? v.destino_lng : null} />
                </td>
                <td className="mono">
                  {v.contenedor_numero ? (
                    v.contenedor_numero
                  ) : asignando === v.id ? (
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <select
                        className="form-select"
                        style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                        value={asignarContenedorNumero}
                        onChange={(e) => setAsignarContenedorNumero(e.target.value)}
                      >
                        <option value="">{v.tipo === 'retiro' ? '— Lleno —' : '— Vacío —'}</option>
                        {(v.tipo === 'retiro' ? contenedoresEntregados : vaciosDisponibles).map((c) => (
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
                        onClick={() => { setAsignando(v.id); setAsignarContenedorNumero(''); }}
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
                {/* Solo lectura: el chofer sale de la ruta en la que se armó el viaje (pestaña Rutas). */}
                <td>{v.chofer_nombre ?? <span className="text-muted">Sin asignar</span>}</td>
                <td className="mono">{v.patente ?? <span className="text-muted">—</span>}</td>
                <td className="mono">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <RoleGate roles={['admin', 'operador']}>
                      <input
                        type="text"
                        className="form-input mono"
                        style={{ padding: '4px 8px', fontSize: '0.8rem', width: '90px' }}
                        placeholder="Nº remito"
                        defaultValue={v.remito ?? ''}
                        key={`${v.id}-${v.remito}`}
                        onBlur={(e) => {
                          if (e.target.value !== (v.remito ?? '')) {
                            cambiarRemito(v.id, e.target.value);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </RoleGate>
                    <RoleGate roles={['finanzas', 'lectura']}>
                      {v.remito ?? <span className="text-muted">—</span>}
                    </RoleGate>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: '4px', minWidth: 'auto' }}
                      title="Imprimir remito oficial"
                      onClick={() => setRemitoImprimir(v)}
                    >
                      <Printer size={13} strokeWidth={2} />
                    </button>
                  </div>
                </td>
                <td>{v.importe ? `$${Number(v.importe).toLocaleString('es-AR')}` : <span className="text-muted">—</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {v.ruta_id ? (
                    <Link
                      to={`/rutas?fecha=${v.fecha}`}
                      className="badge en_curso"
                      style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      title="Ver en el armado de rutas"
                    >
                      <MapPin size={11} strokeWidth={2} />
                      {v.completada_en ? '✓ En ruta' : v.ruta_confirmada_en ? 'Confirmada' : 'Planificada'}
                      {v.orden != null ? ` #${v.orden}` : ''}
                    </Link>
                  ) : (
                    <Link
                      to={`/rutas?fecha=${v.fecha}`}
                      className="badge vacia"
                      style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      title="Pedido sin rutear todavía. Ir a asignarlo a un chofer"
                    >
                      Bolsa (sin rutear)
                    </Link>
                  )}
                </td>
                <td>
                  {(() => {
                    const inicial = v.comprobantes.find((c) => c.tipo !== 'alargue_retiro');
                    const extensiones = v.comprobantes.filter((c) => c.tipo === 'alargue_retiro');
                    const esCC = v.es_cuenta_corriente || inicial?.es_cuenta_corriente;
                    if (!esCC && !inicial && extensiones.length === 0 && !v.tiene_foto_entrega) {
                      return <span className="text-muted">—</span>;
                    }
                    return (
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {esCC ? (
                          <span className="badge pendiente">📋 Cuenta corriente</span>
                        ) : inicial && (
                          <RoleGate roles={['admin', 'operador', 'finanzas']}>
                            <button className="btn btn-ghost btn-sm" onClick={() => setViajeComprobantes(v)}>
                              🧾 Inicial
                            </button>
                          </RoleGate>
                        )}
                        {extensiones.length > 0 && (
                          <RoleGate roles={['admin', 'operador', 'finanzas']}>
                            <button className="btn btn-ghost btn-sm" onClick={() => setViajeComprobantes(v)}>
                              ⏳ Extensión{extensiones.length > 1 ? ` (${extensiones.length})` : ''}
                            </button>
                          </RoleGate>
                        )}
                        {v.tiene_foto_entrega && (
                          <RoleGate roles={['admin', 'operador', 'finanzas']}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setViajeFotoEntrega(v)}
                              title="Ver foto del contenedor entregado en la locación"
                            >
                              📸 Foto
                            </button>
                          </RoleGate>
                        )}
                      </div>
                    );
                  })()}
                </td>
                <td>
                  {(v.estado === 'programado' || v.estado === 'en_curso') && (
                    <RoleGate roles={['admin', 'operador']}>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ color: 'var(--danger)', padding: '4px 6px' }}
                        title="Cancelar viaje"
                        onClick={() => cancelarViaje(v.id)}
                      >
                        <Ban size={13} strokeWidth={2} />
                      </button>
                    </RoleGate>
                  )}
                </td>
              </tr>
            ))}
            {viajesAMostrar.length === 0 && (
              <tr>
                <td colSpan={15} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  {pestana === 'activos' ? 'No hay viajes activos o programados en el rango' : 'No hay viajes en el historial para el rango'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {viajeFotoEntrega && (
        <div className="modal-overlay" onClick={() => setViajeFotoEntrega(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="section-title" style={{ margin: 0 }}>
                📸 Foto de entrega{viajeFotoEntrega.contenedor_numero ? ` · ${viajeFotoEntrega.contenedor_numero}` : ''}
              </div>
              <button className="modal-close" onClick={() => setViajeFotoEntrega(null)}>
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            <p className="text-muted" style={{ marginTop: 0 }}>
              {formatearFecha(viajeFotoEntrega.fecha)} · {viajeFotoEntrega.cliente_telefono ?? '—'} · {viajeFotoEntrega.destino_final_direccion ?? viajeFotoEntrega.destino_direccion ?? '—'}
            </p>
            <ComprobanteViewer viajeFotoId={viajeFotoEntrega.id} />
          </div>
        </div>
      )}

      {viajeComprobantes && (
        <div className="modal-overlay" onClick={() => setViajeComprobantes(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="section-title" style={{ margin: 0 }}>
                Comprobantes · {viajeComprobantes.contenedor_numero ?? viajeComprobantes.tipo}
              </div>
              <button className="modal-close" onClick={() => setViajeComprobantes(null)}>
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            <p className="text-muted" style={{ marginTop: 0 }}>
              {formatearFecha(viajeComprobantes.fecha)} · {viajeComprobantes.cliente_telefono ?? '—'} · {viajeComprobantes.destino_final_direccion ?? viajeComprobantes.destino_direccion ?? '—'}
            </p>
            {viajeComprobantes.comprobantes.length === 0 && (
              <p className="text-muted">Sin comprobantes asociados a este viaje.</p>
            )}
            {viajeComprobantes.comprobantes.map((c) => (
              <div key={c.id} style={{ marginBottom: 18 }}>
                <div className="section-title" style={{ marginBottom: 6 }}>
                  {c.tipo === 'alargue_retiro' ? '⏳ Extensión de retiro' : '🧾 Pago inicial'}
                  {c.monto && ` · $${Number(c.monto).toLocaleString('es-AR')}`}
                  {' · '}<span className={`badge ${c.estado}`}>{c.estado}</span>
                </div>
                {c.titular && <p className="text-muted" style={{ margin: '0 0 6px' }}>Titular: {c.titular}</p>}
                {c.tiene_comprobante ? (
                  <ComprobanteViewer pagoId={c.id} />
                ) : (
                  <span className="text-muted">Sin archivo adjunto (cuenta corriente)</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {remitoImprimir && (
        <div className="modal-overlay" onClick={() => setRemitoImprimir(null)}>
          <div className="modal-panel" style={{ maxWidth: '600px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="section-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={18} /> Remito de Entrega / Retiro
              </div>
              <button className="modal-close" onClick={() => setRemitoImprimir(null)}>
                <X size={18} strokeWidth={2} />
              </button>
            </div>

            <div
              id="remito-print-area"
              style={{
                background: '#fff',
                color: '#111',
                padding: '24px',
                borderRadius: '8px',
                border: '1px solid #e0e0e0',
                fontFamily: 'system-ui, sans-serif',
                marginTop: '12px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '2px solid #222', paddingBottom: '12px', marginBottom: '16px' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.4rem', color: '#000', fontWeight: 800 }}>MORATRANS</h3>
                  <div style={{ fontSize: '0.85rem', color: '#555' }}>Alquiler y Traslado de Contenedores</div>
                  <div style={{ fontSize: '0.85rem', color: '#555' }}>Mendoza, Argentina</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#000' }}>
                    REMITO {remitoImprimir.remito ? `Nº ${remitoImprimir.remito}` : 'PROVISORIO'}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: '#555' }}>Fecha: {formatearFecha(remitoImprimir.fecha)}</div>
                  <div style={{ fontSize: '0.85rem', color: '#555' }}>Tipo: {remitoImprimir.tipo.toUpperCase()}</div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px', fontSize: '0.9rem' }}>
                <div style={{ background: '#f8f9fa', padding: '10px', borderRadius: '4px' }}>
                  <strong>Cliente:</strong>
                  <div>{remitoImprimir.cliente_telefono ?? 'Consumidor Final'}</div>
                  <div style={{ fontSize: '0.82rem', color: '#666' }}>Zona: {remitoImprimir.zona ?? '—'}</div>
                </div>
                <div style={{ background: '#f8f9fa', padding: '10px', borderRadius: '4px' }}>
                  <strong>Chofer / Unidad:</strong>
                  <div>{remitoImprimir.chofer_nombre ?? 'Sin chofer'}</div>
                  <div style={{ fontSize: '0.82rem', color: '#666' }}>Patente: {remitoImprimir.patente ?? '—'}</div>
                </div>
              </div>

              <div style={{ marginBottom: '16px', fontSize: '0.9rem', background: '#f8f9fa', padding: '10px', borderRadius: '4px' }}>
                <strong>Dirección de Servicio:</strong>
                <div>{remitoImprimir.destino_final_direccion ?? remitoImprimir.destino_direccion ?? '—'}</div>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '24px', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ background: '#eee', textAlign: 'left' }}>
                    <th style={{ padding: '8px', border: '1px solid #ddd' }}>Concepto</th>
                    <th style={{ padding: '8px', border: '1px solid #ddd' }}>Contenedor</th>
                    <th style={{ padding: '8px', border: '1px solid #ddd', textAlign: 'right' }}>Importe</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ padding: '8px', border: '1px solid #ddd' }}>
                      Servicio de {remitoImprimir.tipo === 'entrega' ? 'Entrega y colocación' : 'Retiro'}
                    </td>
                    <td style={{ padding: '8px', border: '1px solid #ddd', fontWeight: 'bold' }}>
                      {remitoImprimir.contenedor_numero ?? '—'}
                    </td>
                    <td style={{ padding: '8px', border: '1px solid #ddd', textAlign: 'right', fontWeight: 'bold' }}>
                      {remitoImprimir.importe ? `$${Number(remitoImprimir.importe).toLocaleString('es-AR')}` : 'A convenir'}
                    </td>
                  </tr>
                </tbody>
              </table>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px', marginTop: '40px', paddingTop: '20px' }}>
                <div style={{ borderTop: '1px solid #777', textAlign: 'center', fontSize: '0.8rem', color: '#444' }}>
                  Firma y Aclaración Chofer
                </div>
                <div style={{ borderTop: '1px solid #777', textAlign: 'center', fontSize: '0.8rem', color: '#444' }}>
                  Firma y DNI Conforme Cliente
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' }}>
              <button className="btn btn-ghost" onClick={() => setRemitoImprimir(null)}>Cerrar</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const printContent = document.getElementById('remito-print-area');
                  if (!printContent) return;
                  const win = window.open('', '_blank');
                  if (!win) return;
                  win.document.write(`
                    <html>
                      <head>
                        <title>Remito - Moratrans</title>
                        <style>
                          body { margin: 20px; font-family: system-ui, sans-serif; color: #111; }
                          table { width: 100%; border-collapse: collapse; }
                          th, td { border: 1px solid #ccc; padding: 8px; }
                        </style>
                      </head>
                      <body>${printContent.innerHTML}</body>
                    </html>
                  `);
                  win.document.close();
                  win.focus();
                  win.print();
                }}
              >
                <Printer size={15} /> Imprimir Remito
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
