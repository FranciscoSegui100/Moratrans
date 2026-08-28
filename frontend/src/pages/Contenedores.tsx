import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Wrench, CircleCheck, Pencil, Trash2, Check } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { formatearFechaHora } from '../lib/fechas';

interface Contenedor {
  numero: string;
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
}
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
};

/** Nombre del cliente para mostrar, o el teléfono si todavía no tiene nombre cargado. */
function etiquetaCliente(c: Contenedor): string | null {
  if (!c.cliente_telefono) return null;
  return c.cliente_nombre && c.cliente_nombre !== 'Sin nombre' ? c.cliente_nombre : c.cliente_telefono;
}

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
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ numero: '' });
  const [loading, setLoading] = useState(false);
  const [historialNumero, setHistorialNumero] = useState<string | null>(null);
  const [editandoNumero, setEditandoNumero] = useState(false);
  const [numeroNuevo, setNumeroNuevo] = useState('');

  const { data: contenedores = [] } = useQuery({
    queryKey: ['contenedores'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data),
  });
  const cargar = () => queryClient.invalidateQueries({ queryKey: ['contenedores'] });

  const { data: historial = [], isLoading: cargandoHistorial } = useQuery({
    queryKey: ['contenedores', historialNumero, 'historial'],
    queryFn: () => api.get<HistorialItem[]>(`/api/contenedores/${historialNumero}/historial`).then((r) => r.data),
    enabled: historialNumero !== null,
  });

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/contenedores', form);
      setForm({ numero: '' });
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

  return (
    <div>
      <div className="page-header">
        <h2>Contenedores</h2>
        <p>Alta y seguimiento del inventario de contenedores</p>
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
                onChange={(e) => setForm({ numero: e.target.value })}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Registrar contenedor'}
            </button>
          </form>
        </div>
      </RoleGate>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Estado</th>
              <th>Cliente y dirección</th>
              <th>Chofer asignado</th>
              <th>Vence</th>
              <th>Última actualización</th>
            </tr>
          </thead>
          <tbody>
            {contenedores.map((c) => (
              <tr key={c.numero} onClick={() => { setHistorialNumero(c.numero); setEditandoNumero(false); }} style={{ cursor: 'pointer' }}>
                <td className="mono" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  {c.numero}
                </td>
                <td>
                  <span className={`badge ${c.estado_contrato}`}>
                    {ETIQUETAS_ESTADO[c.estado_contrato] ?? c.estado_contrato.replace('_', ' ')}
                  </span>
                </td>
                <td>
                  {etiquetaCliente(c) ? (
                    <div>
                      <div>{etiquetaCliente(c)}</div>
                      {c.destino_direccion && <div className="text-muted" style={{ fontSize: '0.78rem' }}>{c.destino_direccion}</div>}
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
                  {c.vence_en ? (
                    <span style={{ color: new Date(c.vence_en) < new Date() ? 'var(--danger)' : 'var(--warning)' }}>
                      {formatearFechaHora(c.vence_en)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="text-muted" style={{ whiteSpace: 'nowrap' }}>
                  {formatearFechaHora(c.actualizado_en)}{' '}
                  {c.actualizado_por && <span>· {c.actualizado_por}</span>}
                </td>
              </tr>
            ))}
            {contenedores.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
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
    </div>
  );
}
