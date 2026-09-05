import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpFromLine, ArrowDownToLine, RefreshCw, X, Plus, ChevronDown } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { DireccionMaps } from '../components/DireccionMaps';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { formatearFecha } from '../lib/fechas';
import { hoyISO, sumarDias, fechaEnRango } from '../lib/viajes';

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
  creado_en: string;
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
  comprobantes: Comprobante[];
}
interface Contenedor { numero: string; estado: string; vence_en: string | null; }
interface Tarifa { departamento: string; activo: boolean; }
interface Chofer { id: string; nombre: string; activo: boolean; }
interface Ubicacion { id: string; tipo: 'deposito' | 'vaciadero'; nombre: string; direccion: string; activo: boolean; }

// Mismas franjas que OPCIONES_HORARIO en horarioPreferido.flow.ts — el bot
// guarda exactamente estos textos en viajes.horario_preferido, así que un
// viaje armado a mano tiene que usar los mismos para que la columna
// "Horario sugerido" se vea consistente.
const OPCIONES_HORARIO_SUGERIDO = ['🌅 Mañana (8-12hs)', '🕐 Tarde (12-15hs)'];

const ETIQUETAS_ESTADO_CONTENEDOR: Record<string, string> = {
  disponible: 'Disponible',
  alquilado: 'Alquilado',
  para_retirar: 'Para retirar',
  yendo_a_vaciar: 'Yendo a vaciar',
  vencido: 'Vencido',
};

const formInicial = {
  tipo: 'entrega', fecha: '', horario_preferido: '', zona: '', contenedor_numero: '', contenedor_numero_entrega: '',
  destino_direccion: '', importe: '', ubicacion_id: '',
};

type PestanaViajes = 'activos' | 'historial';
type PresetRango = 'hoy' | 'manana' | 'semana' | 'todo' | 'custom';
/** Un recambio son dos filas con grupo_id: para el filtro de tipo cuenta como su propia categoría. */
const categoriaTipo = (v: Viaje): 'entrega' | 'retiro' | 'recambio' => (v.grupo_id ? 'recambio' : v.tipo);

const PRESETS: { id: PresetRango; label: string }[] = [
  { id: 'hoy', label: 'Hoy' },
  { id: 'manana', label: 'Mañana' },
  { id: 'semana', label: 'Semana' },
  { id: 'todo', label: 'Todo' },
];

export function Viajes() {
  const { show } = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState(formInicial);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [asignando, setAsignando] = useState<string | null>(null);
  const [asignarForm, setAsignarForm] = useState({ contenedor_numero: '', chofer_id: '' });
  const [pestana, setPestana] = useState<PestanaViajes>('activos');
  const [viajeComprobantes, setViajeComprobantes] = useState<Viaje | null>(null);

  const [preset, setPreset] = useState<PresetRango>('semana');
  const [customDesde, setCustomDesde] = useState(() => hoyISO());
  const [customHasta, setCustomHasta] = useState(() => sumarDias(hoyISO(), 6));
  const [filtroZona, setFiltroZona] = useState('');
  const [filtroTipo, setFiltroTipo] = useState<'' | 'entrega' | 'retiro' | 'recambio'>('');

  const { data: viajes = [] } = useQuery({
    queryKey: ['viajes'],
    queryFn: () => api.get<Viaje[]>('/api/viajes').then((r) => r.data),
    refetchInterval: 10_000,
  });
  const { data: contenedores = [] } = useQuery({
    queryKey: ['contenedores'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data),
  });

  // El contenedor y el chofer de una Entrega o un Retiro ya no se piden al
  // programar el viaje: se asignan después, cuando entra a la bolsa de ruta
  // (o desde la columna "Contenedor"/"Chofer" de esta misma tabla, o el
  // tablero), porque hasta ese momento no se sabe cuál corresponde (ver
  // DetalleRuta en Rutas.tsx). El Recambio es la excepción: el contenedor
  // lleno que se va a retirar SÍ se sabe de entrada (es el que ya tiene ese
  // cliente) y el backend lo exige al crear (viajes.routes.ts, "Un recambio
  // necesita...").
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
  const { data: ubicaciones = [] } = useQuery({
    queryKey: ['ubicaciones'],
    queryFn: () => api.get<Ubicacion[]>('/api/ubicaciones').then((r) => r.data.filter((u) => u.activo)),
  });

  // Depósito para una entrega, vaciadero para un retiro. Si hay una sola
  // activa de ese tipo no hace falta elegir: el backend la autoasigna sola.
  const tipoUbicacion = form.tipo === 'entrega' ? 'deposito' : 'vaciadero';
  const ubicacionesElegibles = ubicaciones.filter((u) => u.tipo === tipoUbicacion);
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
      && (!filtroTipo || categoriaTipo(v) === filtroTipo),
    ),
    [viajes, desde, hasta, filtroZona, filtroTipo],
  );

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fecha) return;
    setLoading(true);
    try {
      await api.post('/api/viajes', {
        ...form,
        contenedor_numero: form.tipo === 'recambio' ? (form.contenedor_numero || undefined) : undefined,
        contenedor_numero_entrega: form.tipo === 'recambio' ? (form.contenedor_numero_entrega || undefined) : undefined,
        zona: form.zona || undefined,
        destino_direccion: form.destino_direccion || undefined,
        importe: form.importe || undefined,
        ubicacion_id: form.ubicacion_id || undefined,
        horario_preferido: form.horario_preferido || undefined,
      });
      setForm(formInicial);
      cargar();
      show('success', form.tipo === 'recambio' ? 'Recambio programado correctamente' : 'Viaje programado correctamente');
    } catch (err: any) {
      show('error', 'Error al programar', err.response?.data?.error || 'Error desconocido');
    } finally {
      setLoading(false);
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

  /**
   * Reasignar chofer en cualquier viaje ya creado — sobre todo para la pata
   * "retiro" de un recambio pedido por WhatsApp, que se crea sin chofer (ver
   * recambio.flow.ts): sin esto no había forma de asignárselo desde el panel,
   * y sin chofer_id el bot nunca le ofrece al chofer completar el recambio.
   */
  async function reasignarChofer(id: string, choferId: string) {
    try {
      await api.patch(`/api/viajes/${id}`, { chofer_id: choferId || null });
      cargar();
      show('success', 'Chofer reasignado');
    } catch (err: any) {
      show('error', 'No se pudo reasignar', err.response?.data?.error);
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

  const viajesActivos = viajesEnRango.filter((v) => v.estado === 'programado' || v.estado === 'en_curso');
  const viajesHistorial = viajesEnRango.filter((v) => v.estado === 'completado' || v.estado === 'cancelado');
  const viajesAMostrar = pestana === 'activos' ? viajesActivos : viajesHistorial;

  return (
    <div>
      <div className="page-header">
        <h2>Viajes</h2>
        <p>Gestión operativa de entregas, retiros e historial de viajes</p>
      </div>

      <RoleGate roles={['admin', 'operador']}>
        <div className="form-card">
          <button
            type="button"
            className="btn btn-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            onClick={() => setMostrarForm((v) => !v)}
          >
            <Plus size={15} strokeWidth={2} /> Programar nuevo viaje
            <ChevronDown size={14} strokeWidth={2} style={{ transform: mostrarForm ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
          </button>
          {mostrarForm && (
          <form onSubmit={crear} className="form-row" style={{ marginTop: '14px' }}>
            <div className="form-group">
              <label className="form-label">Tipo</label>
              <select
                className="form-select"
                value={form.tipo}
                onChange={(e) => setForm({ ...form, tipo: e.target.value, contenedor_numero: '', contenedor_numero_entrega: '', ubicacion_id: '' })}
              >
                <option value="entrega">Entrega</option>
                <option value="retiro">Retiro</option>
                <option value="recambio">Recambio</option>
              </select>
            </div>
            {ubicacionesElegibles.length > 1 && (
              <div className="form-group">
                <label className="form-label">{form.tipo === 'entrega' ? 'Sale de' : 'Se descarga en'}</label>
                <select
                  className="form-select"
                  value={form.ubicacion_id}
                  onChange={(e) => setForm({ ...form, ubicacion_id: e.target.value })}
                >
                  <option value="">— Elegir —</option>
                  {ubicacionesElegibles.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
                </select>
              </div>
            )}
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
              <label className="form-label">Horario sugerido</label>
              <select
                className="form-select"
                value={form.horario_preferido}
                onChange={(e) => setForm({ ...form, horario_preferido: e.target.value })}
              >
                <option value="">— Sin preferencia —</option>
                {OPCIONES_HORARIO_SUGERIDO.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Zona</label>
              <select
                className="form-select"
                value={form.zona}
                required={form.tipo === 'recambio'}
                onChange={(e) => setForm({ ...form, zona: e.target.value })}
              >
                <option value="">— Elegir zona —</option>
                {zonas.map((z) => <option key={z.departamento} value={z.departamento}>{z.departamento}</option>)}
              </select>
            </div>
            {form.tipo === 'recambio' && (
              <div className="form-group">
                <label className="form-label">Contenedor lleno (a retirar)</label>
                <select
                  className="form-select"
                  value={form.contenedor_numero}
                  onChange={(e) => {
                    const numero = e.target.value;
                    // Al elegir el lleno, se completan zona/dirección/importe
                    // con los de SU entrega activa (el viaje que lo tiene hoy
                    // con ese cliente) — evita tipearlos de nuevo a mano.
                    const activa = viajes.find((v) => v.contenedor_numero === numero && v.tipo === 'entrega' && (v.estado === 'programado' || v.estado === 'en_curso'));
                    const datosAuto = activa
                      ? { zona: activa.zona ?? '', destino_direccion: activa.destino_direccion ?? '', importe: activa.importe ?? '' }
                      : {};
                    setForm((f) => ({ ...f, contenedor_numero: numero, ...datosAuto }));
                  }}
                >
                  <option value="">— Elegir contenedor entregado —</option>
                  {contenedoresEntregados.map((c) => <option key={c.numero} value={c.numero}>{c.numero}</option>)}
                </select>
              </div>
            )}
            {form.tipo === 'recambio' && (
              <div className="form-group">
                <label className="form-label">Contenedor vacío (a entregar)</label>
                <select
                  className="form-select"
                  value={form.contenedor_numero_entrega}
                  onChange={(e) => setForm({ ...form, contenedor_numero_entrega: e.target.value })}
                >
                  <option value="">— Asignar después —</option>
                  {vaciosDisponibles.map((c) => <option key={c.numero} value={c.numero}>{c.numero}</option>)}
                </select>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Dirección de destino</label>
              <input
                className="form-input"
                placeholder="Ej. Av. San Martín 1234, Godoy Cruz"
                value={form.destino_direccion}
                required={form.tipo === 'recambio'}
                onChange={(e) => setForm({ ...form, destino_direccion: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Importe</label>
              <input
                type="number"
                className="form-input"
                placeholder="Ej. 85000"
                value={form.importe}
                required={form.tipo === 'recambio'}
                onChange={(e) => setForm({ ...form, importe: e.target.value })}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Programar viaje'}
            </button>
          </form>
          )}
        </div>
      </RoleGate>

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
              <th>Fecha de pedido</th>
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
                  <th>Comprobantes</th>
                </tr>
              </thead>
              <tbody>
                {viajesAMostrar.map((v) => (
                  <tr key={v.id}>
                    <td className="strong" style={{ whiteSpace: 'nowrap' }}>{formatearFecha(v.fecha)}</td>
                    <td className="text-muted" style={{ whiteSpace: 'nowrap' }} title="Fecha en la que el cliente pidió el viaje">
                      {formatearFecha(v.creado_en)}
                    </td>
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
                            value={asignarForm.contenedor_numero}
                            onChange={(e) => setAsignarForm({ ...asignarForm, contenedor_numero: e.target.value })}
                          >
                            <option value="">— Vacío —</option>
                            {contenedores.filter((c) => c.estado === 'disponible').map((c) => (
                              <option key={c.numero} value={c.numero}>{c.numero}</option>
                            ))}
                          </select>
                          <select
                            className="form-select"
                            style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                            value={asignarForm.chofer_id}
                            onChange={(e) => setAsignarForm({ ...asignarForm, chofer_id: e.target.value })}
                          >
                            <option value="">— Sin chofer —</option>
                            {choferes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
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
                    <td>
                      <RoleGate roles={['admin', 'operador']}>
                        <select
                          className="form-select"
                          style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                          value={v.chofer_id ?? ''}
                          onChange={(e) => reasignarChofer(v.id, e.target.value)}
                        >
                          <option value="">— Sin asignar —</option>
                          {choferes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                        </select>
                      </RoleGate>
                      <RoleGate roles={['finanzas', 'lectura']}>
                        {v.chofer_nombre ?? <span className="text-muted">Sin asignar</span>}
                      </RoleGate>
                    </td>
                    <td className="mono">{v.patente ?? <span className="text-muted">—</span>}</td>
                    <td className="mono">
                      <RoleGate roles={['admin', 'operador']}>
                        <input
                          type="text"
                          className="form-input mono"
                          style={{ padding: '4px 8px', fontSize: '0.8rem', width: '105px' }}
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
                    </td>
                    <td>{v.importe ? `$${Number(v.importe).toLocaleString('es-AR')}` : <span className="text-muted">—</span>}</td>
                    <td>
                      {(() => {
                        const inicial = v.comprobantes.find((c) => c.tipo !== 'alargue_retiro');
                        const extensiones = v.comprobantes.filter((c) => c.tipo === 'alargue_retiro');
                        const esCC = v.es_cuenta_corriente || inicial?.es_cuenta_corriente;
                        if (!esCC && !inicial && extensiones.length === 0) {
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
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
                {viajesAMostrar.length === 0 && (
                  <tr>
                    <td colSpan={14} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                      {pestana === 'activos' ? 'No hay viajes activos o programados en el rango' : 'No hay viajes en el historial para el rango'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

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
    </div>
  );
}
