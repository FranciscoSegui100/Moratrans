import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { X, Wrench, CircleCheck, Pencil, Trash2, Check, MessageCircle, ArrowUp, ArrowDown, ArrowUpDown, Settings2, UserPlus } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { useAuth, tieneRol } from '../context/AuthContext';
import { formatearFechaHora } from '../lib/fechas';
import { hoyISO, sumarDias } from '../lib/viajes';
import { archivoABase64 } from '../lib/archivos';

interface Contenedor {
  numero: string;
  tamano: number | null;
  estado: string;
  estado_contrato: string;
  cliente_id: string | null;
  vence_en: string | null;
  actualizado_por: string | null;
  actualizado_en: string;
  viaje_tipo: 'entrega' | 'retiro' | null;
  chofer_asignado: string | null;
  cliente_telefono: string | null;
  cliente_nombre: string | null;
  destino_direccion: string | null;
  zona: string | null;
  /** Teléfono del cliente de la entrega vigente si todavía no está cargado en Clientes. */
  gestion_cliente_faltante: string | null;
}
interface Tarifa { departamento: string; precio: string; activo: boolean; }
interface HistorialItem {
  id: string;
  estado: string;
  creado_en: string;
  realizado_por: string;
  ticket_id: string | null;
  ticket_zona: string | null;
  ticket_cliente_telefono: string | null;
}
interface GrupoHistorial {
  ticket_id: string | null;
  ticket_zona: string | null;
  ticket_cliente_telefono: string | null;
  items: HistorialItem[];
}

const ETIQUETAS_ESTADO: Record<string, string> = {
  disponible: 'Disponible',
  alquilado: 'Alquilado',
  para_retirar: 'Para retirar',
  yendo_a_vaciar: 'Yendo a vaciar',
  vencido: 'Vencido',
  mantenimiento: 'En mantenimiento',
  reservado: 'Reservado',
  retirado: 'Retirado (sin vaciar)',
  // Disponible en depósito, pero ya elegido para una entrega de otra ruta
  // sin confirmar todavía — por eso no se puede elegir en ningún otro lado.
  preasignado: 'Disponible · sin confirmar',
};

/** Nombre del cliente para mostrar, o el teléfono si todavía no tiene nombre cargado. */
function etiquetaCliente(c: Contenedor): string | null {
  if (!c.cliente_telefono) return null;
  return c.cliente_nombre && c.cliente_nombre !== 'Sin nombre' ? c.cliente_nombre : c.cliente_telefono;
}

/** Tamaños de contenedor en m³ — mismo CHECK que la columna contenedores.tamano. */
const TAMANOS = [5, 7, 9] as const;

/** El historial viene ordenado por fecha desc; se agrupa por ticket sin
 * reordenar, así cada ciclo de alquiler queda junto en vez de mezclado. */
function agruparPorTicket(historial: HistorialItem[]): GrupoHistorial[] {
  const grupos: GrupoHistorial[] = [];
  for (const h of historial) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.ticket_id === h.ticket_id) {
      ultimo.items.push(h);
    } else {
      grupos.push({ ticket_id: h.ticket_id, ticket_zona: h.ticket_zona, ticket_cliente_telefono: h.ticket_cliente_telefono, items: [h] });
    }
  }
  return grupos;
}

export function Contenedores() {
  const { show } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const puedeEditar = tieneRol(user, 'admin', 'operador');
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ numero: '', tamano: '' });
  const [loading, setLoading] = useState(false);
  const [historialNumero, setHistorialNumero] = useState<string | null>(null);
  const [editandoNumero, setEditandoNumero] = useState(false);
  const [numeroNuevo, setNumeroNuevo] = useState('');

  const { data: contenedores = [] } = useQuery({
    queryKey: ['contenedores'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data),
  });
  const cargar = () => queryClient.invalidateQueries({ queryKey: ['contenedores'] });

  // Gestionar contenedor: los 3 flujos manuales (retiro anticipado, alargue,
  // recambio) que el bot ya resuelve solo por WhatsApp — para un cliente que
  // llama y prefiere saltearse el bot (ver POST /api/contenedores/:numero/…).
  // Para cualquier contenedor entregado, lo haya pedido el cliente por el bot
  // o se haya cargado a mano. ?gestionar=NUM lo reabre directo — es adonde vuelve el alta de cliente
  // cuando se lo mandó a crear desde acá.
  const [gestionarNumero, setGestionarNumero] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('gestionar'),
  );
  const [accionGestion, setAccionGestion] = useState<'retiro_anticipado' | 'alargue' | 'recambio'>('retiro_anticipado');
  const [gestionForm, setGestionForm] = useState({
    fecha: '',
    contenedor_numero_entrega: '',
    medio_pago: 'transferencia' as 'efectivo' | 'transferencia',
    pagado: true,
  });
  const [comprobanteGestion, setComprobanteGestion] = useState<File | null>(null);
  const [guardandoGestion, setGuardandoGestion] = useState(false);

  const { data: zonasTarifas = [] } = useQuery({
    queryKey: ['tarifas', 'activas'],
    queryFn: () => api.get<Tarifa[]>('/api/tarifas').then((r) => r.data.filter((t) => t.activo)),
  });

  function abrirGestion(numero: string) {
    setGestionarNumero(numero);
    setAccionGestion('retiro_anticipado');
    setGestionForm({ fecha: '', contenedor_numero_entrega: '', medio_pago: 'transferencia', pagado: true });
    setComprobanteGestion(null);
  }
  function cerrarGestion() {
    setGestionarNumero(null);
  }

  /** El cliente del contenedor no está en Clientes: hay que crearlo (sin eso la plata no queda a su nombre) y volver acá. */
  function irACrearCliente(numero: string, telefono: string) {
    const volver = `/contenedores?gestionar=${encodeURIComponent(numero)}`;
    navigate(`/clientes?nuevo=1&telefono=${encodeURIComponent(telefono)}&volver=${encodeURIComponent(volver)}`);
  }

  function errorGestion(err: any, titulo: string) {
    const resp = err.response?.data;
    if (resp?.codigo === 'cliente_inexistente' && resp.telefono && gestionarNumero) {
      show('error', 'Falta crear el cliente', resp.error);
      irACrearCliente(gestionarNumero, resp.telefono);
      return;
    }
    show('error', titulo, resp?.error);
  }

  async function confirmarRetiroAnticipado() {
    if (!gestionarNumero || !gestionForm.fecha) return;
    setGuardandoGestion(true);
    try {
      await api.post(`/api/contenedores/${encodeURIComponent(gestionarNumero)}/retiro-anticipado`, { fecha: gestionForm.fecha });
      cargar();
      show('success', 'Retiro anticipado programado', `${gestionarNumero} · ${gestionForm.fecha}`);
      cerrarGestion();
    } catch (err: any) {
      errorGestion(err, 'No se pudo programar');
    } finally {
      setGuardandoGestion(false);
    }
  }

  async function confirmarAlargue() {
    if (!gestionarNumero) return;
    setGuardandoGestion(true);
    try {
      let comprobante_base64: string | undefined;
      let comprobante_content_type: string | undefined;
      if (gestionForm.pagado && gestionForm.medio_pago === 'transferencia' && comprobanteGestion) {
        comprobante_base64 = await archivoABase64(comprobanteGestion);
        comprobante_content_type = comprobanteGestion.type;
      }
      const { data } = await api.post<{ monto: number }>(`/api/contenedores/${encodeURIComponent(gestionarNumero)}/alargue`, {
        medio_pago: gestionForm.medio_pago,
        pagado: gestionForm.pagado,
        comprobante_base64,
        comprobante_content_type,
      });
      cargar();
      show('success', 'Alargue aplicado', `$${Number(data.monto).toLocaleString('es-AR')} · ${gestionarNumero}`);
      cerrarGestion();
    } catch (err: any) {
      errorGestion(err, 'No se pudo aplicar el alargue');
    } finally {
      setGuardandoGestion(false);
    }
  }

  async function confirmarRecambio() {
    if (!gestionarNumero || !gestionForm.fecha || !gestionForm.contenedor_numero_entrega) return;
    setGuardandoGestion(true);
    try {
      let comprobante_base64: string | undefined;
      let comprobante_content_type: string | undefined;
      if (gestionForm.pagado && gestionForm.medio_pago === 'transferencia' && comprobanteGestion) {
        comprobante_base64 = await archivoABase64(comprobanteGestion);
        comprobante_content_type = comprobanteGestion.type;
      }
      await api.post(`/api/contenedores/${encodeURIComponent(gestionarNumero)}/recambio`, {
        fecha: gestionForm.fecha,
        contenedor_numero_entrega: gestionForm.contenedor_numero_entrega,
        medio_pago: gestionForm.medio_pago,
        pagado: gestionForm.pagado,
        comprobante_base64,
        comprobante_content_type,
      });
      cargar();
      show('success', 'Recambio programado', gestionarNumero);
      cerrarGestion();
    } catch (err: any) {
      errorGestion(err, 'No se pudo programar el recambio');
    } finally {
      setGuardandoGestion(false);
    }
  }

  const { data: historial = [], isLoading: cargandoHistorial } = useQuery({
    queryKey: ['contenedores', historialNumero, 'historial'],
    queryFn: () => api.get<HistorialItem[]>(`/api/contenedores/${historialNumero}/historial`).then((r) => r.data),
    enabled: historialNumero !== null,
  });

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/contenedores', { numero: form.numero, tamano: Number(form.tamano) });
      setForm({ numero: '', tamano: '' });
      cargar();
      show('success', 'Contenedor creado', form.numero.toUpperCase());
    } catch (err: any) {
      show('error', 'Error al crear', err.response?.data?.error || 'El número ya existe');
    } finally {
      setLoading(false);
    }
  }

  async function cambiarEstado(numero: string, estado: 'mantenimiento' | 'disponible') {
    try {
      await api.patch(`/api/contenedores/${encodeURIComponent(numero)}/estado`, { estado });
      cargar();
      show('success', estado === 'mantenimiento' ? 'Contenedor puesto en mantenimiento' : 'Contenedor vuelto a disponible', numero);
    } catch (err: any) {
      show('error', 'No se pudo cambiar el estado', err.response?.data?.error);
    }
  }

  function empezarEdicionNumero(numeroActual: string) {
    setNumeroNuevo(numeroActual);
    setEditandoNumero(true);
  }

  async function guardarNumero(numeroActual: string) {
    const nuevo = numeroNuevo.trim().toUpperCase();
    if (!nuevo || nuevo === numeroActual) {
      setEditandoNumero(false);
      return;
    }
    try {
      await api.patch(`/api/contenedores/${encodeURIComponent(numeroActual)}`, { numero: nuevo });
      cargar();
      setEditandoNumero(false);
      setHistorialNumero(nuevo); // el modal sigue abierto, ahora apuntando al número corregido
      show('success', 'Número actualizado', `${numeroActual} → ${nuevo}`);
    } catch (err: any) {
      show('error', 'No se pudo actualizar el número', err.response?.data?.error);
    }
  }

  async function cambiarTamano(numero: string, tamano: number) {
    try {
      await api.patch(`/api/contenedores/${encodeURIComponent(numero)}/tamano`, { tamano });
      cargar();
      show('success', 'Tamaño actualizado', `${numero} · ${tamano} m³`);
    } catch (err: any) {
      show('error', 'No se pudo actualizar el tamaño', err.response?.data?.error);
    }
  }

  async function eliminarContenedor(numero: string) {
    if (!confirm(`¿Eliminar el contenedor ${numero}? Esta acción no se puede deshacer.`)) return;
    try {
      await api.delete(`/api/contenedores/${encodeURIComponent(numero)}`);
      cargar();
      setHistorialNumero(null);
      show('info', 'Contenedor eliminado', numero);
    } catch (err: any) {
      show('error', 'No se pudo eliminar', err.response?.data?.error);
    }
  }

  const [busqueda, setBusqueda] = useState('');
  // Permite llegar con un filtro ya aplicado (ej. desde la tarjeta de
  // "Contenedores por vencer" del Dashboard): /contenedores?filtro=proximos_vencer
  const [filtroEstado, setFiltroEstado] = useState(
    () => new URLSearchParams(window.location.search).get('filtro') || 'todos',
  );

  const contenedoresFiltrados = contenedores.filter((c) => {
    if (filtroEstado !== 'todos' && c.estado_contrato !== filtroEstado && c.estado !== filtroEstado) {
      if (filtroEstado === 'proximos_vencer') {
        if (!c.vence_en) return false;
        const diffMs = new Date(c.vence_en).getTime() - Date.now();
        return diffMs > 0 && diffMs <= 48 * 3600 * 1000;
      }
      return false;
    }
    if (!busqueda) return true;
    const q = busqueda.toLowerCase();
    return (
      c.numero.toLowerCase().includes(q) ||
      (c.cliente_nombre && c.cliente_nombre.toLowerCase().includes(q)) ||
      (c.cliente_telefono && c.cliente_telefono.includes(q)) ||
      (c.destino_direccion && c.destino_direccion.toLowerCase().includes(q)) ||
      (c.chofer_asignado && c.chofer_asignado.toLowerCase().includes(q))
    );
  });

  // Ordenar la tabla con un click en el header de Número/Tamaño/Estado/Vence.
  // Null (sin dato) siempre al final, sin importar la dirección — evita que
  // "nada cargado" se mezcle con valores reales al ordenar.
  type Columna = 'numero' | 'tamano' | 'estado' | 'vence';
  const [orden, setOrden] = useState<{ columna: Columna; dir: 'asc' | 'desc' } | null>(null);

  function pedirOrden(columna: Columna) {
    setOrden((actual) => {
      if (!actual || actual.columna !== columna) return { columna, dir: 'asc' };
      if (actual.dir === 'asc') return { columna, dir: 'desc' };
      return null;
    });
  }

  function iconoOrden(columna: Columna) {
    if (orden?.columna !== columna) return <ArrowUpDown size={12} style={{ verticalAlign: 'middle', opacity: 0.4 }} />;
    return orden.dir === 'asc'
      ? <ArrowUp size={12} style={{ verticalAlign: 'middle' }} />
      : <ArrowDown size={12} style={{ verticalAlign: 'middle' }} />;
  }

  if (orden) {
    const { columna, dir } = orden;
    const signo = dir === 'asc' ? 1 : -1;
    contenedoresFiltrados.sort((a, b) => {
      if (columna === 'numero') return signo * a.numero.localeCompare(b.numero);
      if (columna === 'estado') {
        const la = ETIQUETAS_ESTADO[a.estado_contrato] ?? a.estado_contrato;
        const lb = ETIQUETAS_ESTADO[b.estado_contrato] ?? b.estado_contrato;
        return signo * la.localeCompare(lb);
      }
      if (columna === 'tamano') {
        if (a.tamano == null && b.tamano == null) return 0;
        if (a.tamano == null) return 1;
        if (b.tamano == null) return -1;
        return signo * (a.tamano - b.tamano);
      }
      // vence
      if (!a.vence_en && !b.vence_en) return 0;
      if (!a.vence_en) return 1;
      if (!b.vence_en) return -1;
      return signo * (new Date(a.vence_en).getTime() - new Date(b.vence_en).getTime());
    });
  }

  return (
    <div>
      <div className="page-header">
        <h2>Contenedores</h2>
        <p>Alta, filtros y seguimiento del inventario de contenedores</p>
      </div>

      <RoleGate roles={['admin', 'operador']}>
        <div className="form-card">
          <div className="section-title">Registrar contenedor</div>
          <form onSubmit={crear} className="form-row">
            <div className="form-group">
              <label className="form-label">Número de contenedor</label>
              <input
                className="form-input"
                placeholder="Ej. MSKU1234567"
                value={form.numero}
                required
                style={{ textTransform: 'uppercase' }}
                onChange={(e) => setForm({ ...form, numero: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Tamaño</label>
              <select
                className="form-select"
                value={form.tamano}
                required
                onChange={(e) => setForm({ ...form, tamano: e.target.value })}
              >
                <option value="" disabled>Seleccionar…</option>
                {TAMANOS.map((t) => (
                  <option key={t} value={t}>{t} m³</option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Registrar contenedor'}
            </button>
          </form>
        </div>
      </RoleGate>

      {/* Barra de filtros rápidos de inventario */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
        <input
          type="text"
          className="form-input"
          style={{ width: '260px' }}
          placeholder="🔍 Buscar por número, cliente, dir..."
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />
        <div className="btn-group">
          {[
            { id: 'todos', label: 'Todos' },
            { id: 'disponible', label: 'Disponibles' },
            { id: 'alquilado', label: 'Alquilados' },
            { id: 'proximos_vencer', label: '⏳ Vencen en 48h' },
            { id: 'vencido', label: '⚠️ Vencidos' },
            { id: 'mantenimiento', label: 'Mantenimiento' },
          ].map((f) => (
            <button
              key={f.id}
              className={`btn btn-sm ${filtroEstado === f.id ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFiltroEstado(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-muted" style={{ fontSize: '0.82rem', marginLeft: 'auto' }}>
          Mostrando {contenedoresFiltrados.length} de {contenedores.length} contenedores
        </span>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th onClick={() => pedirOrden('numero')} style={{ cursor: 'pointer', userSelect: 'none' }} title="Ordenar por número">
                Número {iconoOrden('numero')}
              </th>
              <th onClick={() => pedirOrden('tamano')} style={{ cursor: 'pointer', userSelect: 'none' }} title="Ordenar por tamaño">
                Tamaño {iconoOrden('tamano')}
              </th>
              <th onClick={() => pedirOrden('estado')} style={{ cursor: 'pointer', userSelect: 'none' }} title="Ordenar por estado">
                Estado {iconoOrden('estado')}
              </th>
              <th>Cliente y dirección</th>
              <th>Chofer asignado</th>
              <th onClick={() => pedirOrden('vence')} style={{ cursor: 'pointer', userSelect: 'none' }} title="Ordenar por fecha de vencimiento">
                Vence {iconoOrden('vence')}
              </th>
              <th>Última actualización</th>
              <th>Gestionar</th>
            </tr>
          </thead>
          <tbody>
            {contenedoresFiltrados.map((c) => (
              <tr key={c.numero} onClick={() => { setHistorialNumero(c.numero); setEditandoNumero(false); }} style={{ cursor: 'pointer' }}>
                <td className="mono" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  {c.numero}
                </td>
                <td>{c.tamano ? `${c.tamano} m³` : <span className="text-muted">—</span>}</td>
                <td>
                  <span
                    className={`badge ${c.estado_contrato}`}
                    title={c.estado_contrato === 'preasignado' ? 'Está en el depósito, pero ya elegido para una entrega de otra ruta que todavía no se confirmó — por eso no aparece como opción en ningún otro pedido.' : undefined}
                  >
                    {ETIQUETAS_ESTADO[c.estado_contrato] ?? c.estado_contrato.replace('_', ' ')}
                  </span>
                </td>
                <td>
                  {etiquetaCliente(c) ? (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                      <div>
                        <div>{etiquetaCliente(c)}</div>
                        {c.destino_direccion && <div className="text-muted" style={{ fontSize: '0.78rem' }}>{c.destino_direccion}</div>}
                      </div>
                      {c.cliente_telefono && (
                        <Link
                          to={`/conversaciones?tel=${encodeURIComponent(c.cliente_telefono)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="btn btn-ghost btn-sm"
                          title="Hablar con este cliente en Conversaciones"
                          style={{ flexShrink: 0, padding: '4px 6px', color: 'var(--accent)' }}
                        >
                          <MessageCircle size={16} />
                        </Link>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td>
                  {c.chofer_asignado ? (
                    <span>
                      {c.chofer_asignado}{' '}
                      <span className="text-muted">({c.viaje_tipo})</span>
                    </span>
                  ) : (c.estado === 'reservado' || c.estado === 'entregado') ? (
                    <span style={{ color: 'var(--danger)' }} title="Contenedor sin chofer ni viaje asignado">
                      Sin asignar
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {c.vence_en ? (() => {
                    const diffMs = new Date(c.vence_en).getTime() - Date.now();
                    const color = diffMs < 0 ? 'var(--danger)' : diffMs <= 48 * 3600 * 1000 ? 'var(--warning)' : 'inherit';
                    return (
                      <span style={{ color, fontWeight: diffMs <= 48 * 3600 * 1000 ? 600 : 'normal' }}>
                        {formatearFechaHora(c.vence_en)}
                      </span>
                    );
                  })() : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="text-muted" style={{ whiteSpace: 'nowrap' }}>
                  {formatearFechaHora(c.actualizado_en)}{' '}
                  {c.actualizado_por && <span>· {c.actualizado_por}</span>}
                </td>
                <td>
                  <RoleGate roles={['admin', 'operador']}>
                    {c.estado === 'entregado' ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        title="Retiro anticipado, alargue o recambio para este contenedor"
                        onClick={(e) => { e.stopPropagation(); abrirGestion(c.numero); }}
                      >
                        <Settings2 size={14} strokeWidth={1.75} /> Gestionar
                      </button>
                    ) : (
                      <span
                        className="text-muted"
                        style={{ fontSize: '0.78rem' }}
                        title="Solo disponible para contenedores entregados a un cliente"
                      >—</span>
                    )}
                  </RoleGate>
                </td>
              </tr>
            ))}
            {contenedores.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  No hay contenedores registrados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {historialNumero && (
        <div className="modal-overlay" onClick={() => { setHistorialNumero(null); setEditandoNumero(false); }}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              {editandoNumero ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input
                    className="form-input"
                    style={{ textTransform: 'uppercase', maxWidth: '200px' }}
                    value={numeroNuevo}
                    autoFocus
                    onChange={(e) => setNumeroNuevo(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && guardarNumero(historialNumero)}
                  />
                  <button className="btn btn-success btn-sm" onClick={() => guardarNumero(historialNumero)}>
                    <Check strokeWidth={2} />
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditandoNumero(false)}>
                    Cancelar
                  </button>
                </div>
              ) : (
                <div className="section-title" style={{ margin: 0 }}>
                  Historial · {historialNumero}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <RoleGate roles={['admin', 'operador']}>
                  {!editandoNumero && (
                    <button className="btn btn-ghost btn-sm" onClick={() => empezarEdicionNumero(historialNumero)}>
                      <Pencil size={16} strokeWidth={1.75} /> Editar número
                    </button>
                  )}
                  {(() => {
                    const cont = contenedores.find((c) => c.numero === historialNumero);
                    if (cont?.estado !== 'entregado') return null;
                    return (
                      <button className="btn btn-ghost btn-sm" onClick={() => abrirGestion(historialNumero)}>
                        <Settings2 size={16} strokeWidth={1.75} /> Gestionar
                      </button>
                    );
                  })()}
                  {(() => {
                    const cont = contenedores.find((c) => c.numero === historialNumero);
                    if (!cont) return null;
                    if (cont.estado === 'mantenimiento') {
                      return (
                        <button className="btn btn-success btn-sm" onClick={() => cambiarEstado(historialNumero, 'disponible')}>
                          <CircleCheck size={16} strokeWidth={1.75} /> Volver a disponible
                        </button>
                      );
                    }
                    if (cont.estado === 'disponible' || cont.estado === 'retirado') {
                      return (
                        <button className="btn btn-danger btn-sm" onClick={() => cambiarEstado(historialNumero, 'mantenimiento')}>
                          <Wrench size={16} strokeWidth={1.75} /> Marcar en mantenimiento
                        </button>
                      );
                    }
                    return null;
                  })()}
                  {!cargandoHistorial && historial.length <= 1 && (
                    <button
                      className="btn btn-danger btn-sm"
                      title="Solo se puede eliminar un contenedor que nunca tuvo movimientos"
                      onClick={() => eliminarContenedor(historialNumero)}
                    >
                      <Trash2 size={16} strokeWidth={1.75} /> Eliminar
                    </button>
                  )}
                </RoleGate>
                <button className="modal-close" onClick={() => { setHistorialNumero(null); setEditandoNumero(false); }}>
                  <X size={18} strokeWidth={2} />
                </button>
              </div>
            </div>
            {(() => {
              const cont = contenedores.find((c) => c.numero === historialNumero);
              if (!cont) return null;
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: 14, fontSize: '0.85rem' }}>
                  <strong>Tamaño:</strong>
                  {puedeEditar ? (
                    <select
                      className="form-select"
                      style={{ width: 'auto' }}
                      value={cont.tamano ?? ''}
                      onChange={(e) => cambiarTamano(cont.numero, Number(e.target.value))}
                    >
                      {cont.tamano === null && <option value="" disabled>Sin cargar</option>}
                      {TAMANOS.map((t) => (
                        <option key={t} value={t}>{t} m³</option>
                      ))}
                    </select>
                  ) : (
                    <span>{cont.tamano ? `${cont.tamano} m³` : 'Sin cargar'}</span>
                  )}
                </div>
              );
            })()}
            {(() => {
              const cont = contenedores.find((c) => c.numero === historialNumero);
              if (!cont) return null;
              const cliente = etiquetaCliente(cont);
              if (!cliente && !cont.vence_en) return null;
              return (
                <div className="card" style={{ marginBottom: 14, padding: '10px 14px' }}>
                  {cliente && (
                    <div style={{ fontSize: '0.85rem' }}>
                      <strong>Cliente:</strong> {cliente}
                    </div>
                  )}
                  {cont.destino_direccion && (
                    <div style={{ fontSize: '0.85rem' }}>
                      <strong>Dirección:</strong> {cont.destino_direccion}
                    </div>
                  )}
                  {cont.vence_en && (
                    <div style={{ fontSize: '0.85rem', color: new Date(cont.vence_en) < new Date() ? 'var(--danger)' : undefined }}>
                      <strong>Vence:</strong> {formatearFechaHora(cont.vence_en)}
                    </div>
                  )}
                </div>
              );
            })()}
            {cargandoHistorial && <p className="text-muted">Cargando historial…</p>}
            {!cargandoHistorial && historial.length === 0 && (
              <p className="text-muted">Sin movimientos registrados para este contenedor.</p>
            )}
            {!cargandoHistorial && historial.length > 0 && agruparPorTicket(historial).map((grupo, i) => (
              <div key={grupo.ticket_id ?? `sin-ticket-${i}`} style={{ marginBottom: 18 }}>
                <div className="section-title" style={{ marginBottom: 6 }}>
                  {grupo.ticket_id
                    ? `Ticket ${grupo.ticket_id.slice(0, 8)}${grupo.ticket_zona ? ` · ${grupo.ticket_zona}` : ''}${grupo.ticket_cliente_telefono ? ` · ${grupo.ticket_cliente_telefono}` : ''}`
                    : 'Sin ticket asociado'}
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Estado</th>
                      <th>Hecho por</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grupo.items.map((h) => (
                      <tr key={h.id}>
                        <td className="text-muted" style={{ whiteSpace: 'nowrap' }}>{formatearFechaHora(h.creado_en)}</td>
                        <td>
                          <span className={`badge ${h.estado}`}>{h.estado.replace('_', ' ')}</span>
                        </td>
                        <td>{h.realizado_por}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      )}

      {gestionarNumero && (() => {
        const cont = contenedores.find((c) => c.numero === gestionarNumero);
        if (!cont) return null;
        const hoy = hoyISO();
        const venceFecha = cont.vence_en ? cont.vence_en.slice(0, 10) : null;
        const maxRetiroAnticipado = venceFecha ? sumarDias(venceFecha, -1) : undefined;
        const tarifa = cont.zona ? zonasTarifas.find((z) => z.departamento === cont.zona) : undefined;
        const montoAlargue = tarifa ? Math.round(Number(tarifa.precio) * 0.5) : null;
        const montoRecambio = tarifa ? Number(tarifa.precio) : null;
        const contenedoresDisponibles = contenedores.filter((c) => c.estado === 'disponible');

        return (
          <div className="modal-overlay" onClick={cerrarGestion}>
            <div className="modal-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
              <div className="modal-header">
                <div className="section-title" style={{ margin: 0 }}>Gestionar · {gestionarNumero}</div>
                <button className="modal-close" onClick={cerrarGestion}>
                  <X size={18} strokeWidth={2} />
                </button>
              </div>

              <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: 14 }}>
                {etiquetaCliente(cont)} {cont.destino_direccion && `· ${cont.destino_direccion}`}
                {venceFecha && ` · Vence ${formatearFechaHora(cont.vence_en!)}`}
              </div>

              {cont.gestion_cliente_faltante ? (
                <div>
                  <p style={{ fontSize: '0.85rem' }}>
                    El cliente de este contenedor (<strong>{cont.gestion_cliente_faltante}</strong>) todavía no está cargado en Clientes.
                    Hay que crearlo antes de cargar un retiro, alargue o recambio, para que los cobros queden en su cuenta.
                  </p>
                  <button className="btn btn-primary" onClick={() => irACrearCliente(cont.numero, cont.gestion_cliente_faltante!)}>
                    <UserPlus size={16} strokeWidth={1.75} /> Crear cliente
                  </button>
                </div>
              ) : (<>

              <div className="btn-group" style={{ marginBottom: 16 }}>
                <button
                  className={`btn btn-sm ${accionGestion === 'retiro_anticipado' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setAccionGestion('retiro_anticipado')}
                >
                  Retiro anticipado
                </button>
                <button
                  className={`btn btn-sm ${accionGestion === 'alargue' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setAccionGestion('alargue')}
                >
                  Alargue
                </button>
                <button
                  className={`btn btn-sm ${accionGestion === 'recambio' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setAccionGestion('recambio')}
                >
                  Recambio
                </button>
              </div>

              {accionGestion === 'retiro_anticipado' && (
                <div className="form-row">
                  {!venceFecha ? (
                    <p className="text-muted">Este contenedor no tiene fecha de vencimiento cargada.</p>
                  ) : (
                    <>
                      <p className="text-muted" style={{ fontSize: '0.82rem' }}>
                        Sin costo — no se descuenta del alquiler. Tiene que ser antes del vencimiento ({formatearFechaHora(cont.vence_en!)}).
                      </p>
                      <div className="form-group">
                        <label className="form-label">Fecha de retiro</label>
                        <input
                          type="date"
                          className="form-input"
                          value={gestionForm.fecha}
                          min={hoy}
                          max={maxRetiroAnticipado}
                          onChange={(e) => setGestionForm({ ...gestionForm, fecha: e.target.value })}
                        />
                      </div>
                      <button
                        className="btn btn-primary"
                        disabled={guardandoGestion || !gestionForm.fecha}
                        onClick={confirmarRetiroAnticipado}
                      >
                        {guardandoGestion ? 'Guardando...' : 'Confirmar retiro anticipado'}
                      </button>
                    </>
                  )}
                </div>
              )}

              {accionGestion === 'alargue' && (
                <div className="form-row">
                  <p className="text-muted" style={{ fontSize: '0.82rem' }}>
                    Estira el vencimiento 5 días{montoAlargue != null && <> — cuesta <strong>${montoAlargue.toLocaleString('es-AR')}</strong> (50% de la tarifa de {cont.zona})</>}.
                  </p>
                  <div className="form-group">
                    <label className="form-label">Medio de pago</label>
                    <select
                      className="form-select"
                      value={gestionForm.medio_pago}
                      onChange={(e) => setGestionForm({ ...gestionForm, medio_pago: e.target.value as 'efectivo' | 'transferencia' })}
                    >
                      <option value="transferencia">Transferencia</option>
                      <option value="efectivo">Efectivo</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        type="checkbox"
                        checked={gestionForm.pagado}
                        onChange={(e) => setGestionForm({ ...gestionForm, pagado: e.target.checked })}
                      />
                      Ya está pagado
                    </label>
                    {!gestionForm.pagado && (
                      <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                        Queda como deuda del cliente — si no es cuenta corriente, se le manda el pedido de pago por WhatsApp.
                      </div>
                    )}
                  </div>
                  {gestionForm.pagado && gestionForm.medio_pago === 'transferencia' && (
                    <div className="form-group">
                      <label className="form-label">Comprobante (opcional)</label>
                      <input type="file" accept="image/*,.pdf" onChange={(e) => setComprobanteGestion(e.target.files?.[0] ?? null)} />
                    </div>
                  )}
                  <button className="btn btn-primary" disabled={guardandoGestion} onClick={confirmarAlargue}>
                    {guardandoGestion ? 'Guardando...' : 'Confirmar alargue'}
                  </button>
                </div>
              )}

              {accionGestion === 'recambio' && (
                <div className="form-row">
                  <p className="text-muted" style={{ fontSize: '0.82rem' }}>
                    Misma dirección y zona del contenedor actual{montoRecambio != null && <> — cuesta <strong>${montoRecambio.toLocaleString('es-AR')}</strong></>}.
                    {venceFecha && ` Tiene que ser hasta el vencimiento (${formatearFechaHora(cont.vence_en!)}).`}
                  </p>
                  <div className="form-group">
                    <label className="form-label">Fecha</label>
                    <input
                      type="date"
                      className="form-input"
                      value={gestionForm.fecha}
                      min={hoy}
                      max={venceFecha ?? undefined}
                      onChange={(e) => setGestionForm({ ...gestionForm, fecha: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Contenedor vacío a dejar</label>
                    <select
                      className="form-select"
                      value={gestionForm.contenedor_numero_entrega}
                      onChange={(e) => setGestionForm({ ...gestionForm, contenedor_numero_entrega: e.target.value })}
                    >
                      <option value="">— Elegir contenedor —</option>
                      {contenedoresDisponibles.map((c) => <option key={c.numero} value={c.numero}>{c.numero}</option>)}
                    </select>
                    {contenedoresDisponibles.length === 0 && (
                      <div className="text-muted" style={{ fontSize: '0.78rem' }}>No hay contenedores disponibles en depósito ahora mismo.</div>
                    )}
                  </div>
                  <div className="form-group">
                    <label className="form-label">Medio de pago</label>
                    <select
                      className="form-select"
                      value={gestionForm.medio_pago}
                      onChange={(e) => setGestionForm({ ...gestionForm, medio_pago: e.target.value as 'efectivo' | 'transferencia' })}
                    >
                      <option value="transferencia">Transferencia</option>
                      <option value="efectivo">Efectivo</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        type="checkbox"
                        checked={gestionForm.pagado}
                        onChange={(e) => setGestionForm({ ...gestionForm, pagado: e.target.checked })}
                      />
                      Ya está pagado
                    </label>
                    {!gestionForm.pagado && (
                      <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                        Queda como deuda del cliente — si no es cuenta corriente, se le manda el pedido de pago por WhatsApp.
                      </div>
                    )}
                  </div>
                  {gestionForm.pagado && gestionForm.medio_pago === 'transferencia' && (
                    <div className="form-group">
                      <label className="form-label">Comprobante (opcional)</label>
                      <input type="file" accept="image/*,.pdf" onChange={(e) => setComprobanteGestion(e.target.files?.[0] ?? null)} />
                    </div>
                  )}
                  <button
                    className="btn btn-primary"
                    disabled={guardandoGestion || !gestionForm.fecha || !gestionForm.contenedor_numero_entrega}
                    onClick={confirmarRecambio}
                  >
                    {guardandoGestion ? 'Guardando...' : 'Confirmar recambio'}
                  </button>
                </div>
              )}
              </>)}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
