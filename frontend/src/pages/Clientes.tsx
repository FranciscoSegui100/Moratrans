import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Download, Pencil, Plus, MessageCircle, ArrowUpDown, Trash2 } from 'lucide-react';
import { api, descargarArchivo } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { useAuth, tieneRol } from '../context/AuthContext';

interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  cuenta_corriente_estado: 'sin_pedir' | 'pendiente' | 'aprobada' | 'rechazada';
  numero_plan: number | null;
  cantidad_viajes: number;
  deuda: number;
}

type Pestana = 'cuenta_corriente' | 'ocasionales';

// Cuenta corriente: la tiene aprobada o la está pidiendo (ver pago.flow.ts).
// Ocasionales: paga por transferencia en cada viaje — nunca la pidió, o se
// la rechazaron.
function esCuentaCorriente(c: Cliente): boolean {
  return c.cuenta_corriente_estado === 'aprobada' || c.cuenta_corriente_estado === 'pendiente';
}

export function Clientes() {
  const { show } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const puedeEditarPlan = tieneRol(user, 'admin', 'operador', 'finanzas');
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [editandoPlan, setEditandoPlan] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState('');
  const [pestana, setPestana] = useState<Pestana>('cuenta_corriente');
  // ?nuevo=1 abre el alta directo — lo usa "Programar nuevo viaje" en
  // Rutas.tsx cuando el cliente que se busca todavía no existe.
  const [mostrarAlta, setMostrarAlta] = useState(() => searchParams.get('nuevo') === '1');
  // ?telefono= y ?volver= los usa "Gestionar" en Contenedores.tsx: el
  // teléfono es el del contenedor (no se puede cambiar, si no el cliente
  // nuevo no quedaría asociado) y al crear se vuelve a ese modal.
  const telefonoFijo = searchParams.get('telefono');
  const volverA = searchParams.get('volver');
  const [altaForm, setAltaForm] = useState<{ nombre: string; telefono: string; tipo: 'cuenta_corriente' | 'ocasional' }>(
    { nombre: '', telefono: telefonoFijo ?? '', tipo: 'cuenta_corriente' },
  );
  const [creando, setCreando] = useState(false);
  const [eliminandoOcasionales, setEliminandoOcasionales] = useState(false);

  const { data: todosLosClientes = [] } = useQuery({
    queryKey: ['clientes'],
    queryFn: () => api.get<Cliente[]>('/api/clientes').then((r) => r.data),
  });
  const clientesCC = todosLosClientes.filter(esCuentaCorriente);
  const clientesOcasionales = todosLosClientes.filter((c) => !esCuentaCorriente(c));
  const ocasionalesSinDeuda = clientesOcasionales.filter((c) => Number(c.deuda) <= 0);
  const clientesPestana = pestana === 'cuenta_corriente' ? clientesCC : clientesOcasionales;

  // Con 100 clientes el orden alfabético de la API no alcanza para
  // encontrar "quién me debe plata" sin escanear toda la tabla a mano —
  // un toggle de "solo con deuda" + poder ordenar por esa columna lo
  // resuelve sin tocar nada del backend (el monto ya viene en la respuesta).
  // Permite llegar con el filtro ya aplicado desde la tarjeta "Deuda de
  // clientes" del Dashboard: /clientes?deuda=1
  const [soloConDeuda, setSoloConDeuda] = useState(
    () => new URLSearchParams(window.location.search).get('deuda') === '1',
  );
  const [ordenarPorDeuda, setOrdenarPorDeuda] = useState(
    () => new URLSearchParams(window.location.search).get('deuda') === '1',
  );
  const clientesConDeudaCount = clientesPestana.filter((c) => Number(c.deuda) > 0).length;

  const clientes = (soloConDeuda ? clientesPestana.filter((c) => Number(c.deuda) > 0) : clientesPestana)
    .slice()
    .sort((a, b) => (ordenarPorDeuda ? Number(b.deuda) - Number(a.deuda) : 0));

  async function crearCliente() {
    if (!altaForm.nombre.trim() || !altaForm.telefono.trim()) {
      show('error', 'Completá nombre y teléfono');
      return;
    }
    setCreando(true);
    try {
      await api.post('/api/clientes', {
        nombre: altaForm.nombre.trim(),
        telefono: altaForm.telefono.trim(),
        cuenta_corriente_estado: altaForm.tipo === 'cuenta_corriente' ? 'aprobada' : 'sin_pedir',
      });
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      show('success', 'Cliente creado', altaForm.tipo === 'cuenta_corriente' ? 'Con cuenta corriente activa.' : 'Como ocasional.');
      setAltaForm({ nombre: '', telefono: '', tipo: 'cuenta_corriente' });
      setMostrarAlta(false);
      // Solo rutas internas del panel, nunca una URL externa.
      if (volverA?.startsWith('/') && !volverA.startsWith('//')) navigate(volverA);
    } catch (err: any) {
      show('error', 'No se pudo crear el cliente', err.response?.data?.error);
    } finally {
      setCreando(false);
    }
  }

  async function guardarPlan(id: string) {
    try {
      await api.patch(`/api/clientes/${id}`, { numero_plan: planForm ? Number(planForm) : null });
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      setEditandoPlan(null);
      show('success', 'Nº de plan actualizado');
    } catch (err: any) {
      show('error', 'No se pudo guardar', err.response?.data?.error);
    }
  }

  async function eliminarOcasionalesSinDeuda() {
    if (ocasionalesSinDeuda.length === 0) return;
    const conDeuda = clientesOcasionales.length - ocasionalesSinDeuda.length;
    const notaDeuda = conDeuda > 0
      ? ` Los ${conDeuda} cliente(s) con deuda pendiente NO se eliminarán.`
      : '';
    if (!confirm(`¿Eliminar a los ${ocasionalesSinDeuda.length} cliente(s) ocasionales sin deuda pendiente?${notaDeuda}`)) return;
    setEliminandoOcasionales(true);
    try {
      const { data } = await api.delete<{ ok: true; eliminados: number }>('/api/clientes/ocasionales-sin-deuda');
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      show('success', 'Clientes ocasionales eliminados', `Se eliminaron ${data.eliminados} cliente(s) sin deuda.`);
    } catch (err: any) {
      show('error', 'No se pudieron eliminar', err.response?.data?.error || 'Error desconocido');
    } finally {
      setEliminandoOcasionales(false);
    }
  }

  async function eliminarClienteIndividual(c: Cliente) {
    if (!confirm(`¿Eliminar al cliente ocasional ${c.nombre} (${c.telefono})?`)) return;
    try {
      await api.delete(`/api/clientes/${c.id}`);
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      show('success', 'Cliente eliminado', `${c.nombre} fue eliminado del padrón.`);
    } catch (err: any) {
      show('error', 'No se pudo eliminar', err.response?.data?.error || 'Error desconocido');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Clientes</h2>
        <p>Padrón de clientes y cuenta corriente — entrá a uno para ver sus viajes por mes</p>
      </div>

      <div className="form-card" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          onClick={() => descargarArchivo('/api/clientes/export.xlsx', 'clientes-y-pedidos.xlsx')}
        >
          <Download strokeWidth={1.75} /> Exportar clientes y pedidos a Excel
        </button>
        <small className="text-muted">Incluye 3 hojas: resumen facturado por mes, listado de clientes, y el detalle de todos los pedidos.</small>
        <RoleGate roles={['admin', 'operador', 'finanzas']}>
          <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setMostrarAlta((v) => !v)}>
            <Plus strokeWidth={1.75} /> Nuevo cliente
          </button>
        </RoleGate>
      </div>

      {mostrarAlta && (
        <div className="form-card" style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Nombre</label>
            <input
              className="form-input"
              value={altaForm.nombre}
              onChange={(e) => setAltaForm({ ...altaForm, nombre: e.target.value })}
              placeholder="Nombre y apellido"
            />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Teléfono</label>
            <input
              className="form-input"
              value={altaForm.telefono}
              readOnly={!!telefonoFijo}
              onChange={(e) => setAltaForm({ ...altaForm, telefono: e.target.value })}
              placeholder="261 5 12-3456"
            />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Tipo</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                className={`btn btn-sm ${altaForm.tipo === 'cuenta_corriente' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setAltaForm({ ...altaForm, tipo: 'cuenta_corriente' })}
              >
                Cuenta corriente
              </button>
              <button
                type="button"
                className={`btn btn-sm ${altaForm.tipo === 'ocasional' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setAltaForm({ ...altaForm, tipo: 'ocasional' })}
              >
                Ocasional
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', paddingBottom: '2px' }}>
            <button className="btn btn-success" onClick={crearCliente} disabled={creando}>
              {creando ? 'Creando...' : 'Crear'}
            </button>
            <button className="btn btn-ghost" onClick={() => setMostrarAlta(false)}>Cancelar</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          className={`btn btn-sm ${pestana === 'cuenta_corriente' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setPestana('cuenta_corriente')}
        >
          Cuenta corriente ({clientesCC.length})
        </button>
        <button
          className={`btn btn-sm ${pestana === 'ocasionales' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setPestana('ocasionales')}
        >
          Ocasionales ({clientesOcasionales.length})
        </button>
        {pestana === 'ocasionales' && ocasionalesSinDeuda.length > 0 && (
          <RoleGate roles={['admin', 'operador', 'finanzas']}>
            <button
              className="btn btn-danger btn-sm"
              onClick={eliminarOcasionalesSinDeuda}
              disabled={eliminandoOcasionales}
              title="Elimina todos los clientes ocasionales que no tienen deuda pendiente"
            >
              <Trash2 size={14} strokeWidth={2} />{' '}
              {eliminandoOcasionales
                ? 'Eliminando...'
                : `Eliminar ocasionales sin deuda (${ocasionalesSinDeuda.length})`}
            </button>
          </RoleGate>
        )}
        <button
          className={`btn btn-sm ${soloConDeuda ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setSoloConDeuda((v) => !v)}
          style={{ marginLeft: 'auto' }}
        >
          💸 Clientes con deuda ({clientesConDeudaCount})
        </button>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Teléfono</th>
              <th>Nº plan</th>
              <th>Pedidos</th>
              <th
                onClick={() => setOrdenarPorDeuda((v) => !v)}
                style={{ cursor: 'pointer', userSelect: 'none' }}
                title="Ordenar por deuda"
              >
                Deuda {ordenarPorDeuda ? <ArrowUpDown size={12} style={{ verticalAlign: 'middle' }} /> : null}
              </th>
            </tr>
          </thead>
          <tbody>
            {clientes.map((c) => {
              const debe = Number(c.deuda) > 0;
              return (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/clientes/${encodeURIComponent(c.telefono)}`)}
                  style={{ cursor: 'pointer' }}
                  title="Ver perfil del cliente"
                >
                  <td className="strong">{c.nombre}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span>{c.telefono}</span>
                      <Link
                        to={`/conversaciones?tel=${encodeURIComponent(c.telefono)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="btn btn-ghost btn-sm"
                        title="Hablar con este cliente en Conversaciones"
                        style={{ flexShrink: 0, padding: '4px 6px', color: 'var(--accent)' }}
                      >
                        <MessageCircle size={16} />
                      </Link>
                    </div>
                  </td>
                  <td className="mono" onClick={(e) => e.stopPropagation()}>
                    {editandoPlan === c.id ? (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <input
                          className="form-input"
                          style={{ width: '70px', padding: '4px 8px' }}
                          type="number"
                          value={planForm}
                          onChange={(e) => setPlanForm(e.target.value)}
                        />
                        <button className="btn btn-success btn-sm" onClick={() => guardarPlan(c.id)}>OK</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditandoPlan(null)}>✕</button>
                      </div>
                    ) : puedeEditarPlan ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setEditandoPlan(c.id); setPlanForm(c.numero_plan?.toString() ?? ''); }}
                      >
                        {c.numero_plan ?? <span className="text-muted">Asignar</span>} <Pencil size={11} strokeWidth={1.75} />
                      </button>
                    ) : (
                      c.numero_plan ?? <span className="text-muted">—</span>
                    )}
                  </td>
                  <td>{c.cantidad_viajes}</td>
                  <td>
                    {esCuentaCorriente(c) ? (
                      debe
                        ? <span className="badge rechazado">Debe ${Number(c.deuda).toLocaleString('es-AR')}</span>
                        : <span className="badge disponible">Al día</span>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {debe
                          ? <span className="badge rechazado">Sí · ${Number(c.deuda).toLocaleString('es-AR')}</span>
                          : <span className="badge disponible">No</span>}
                        {!debe && puedeEditarPlan && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={(e) => { e.stopPropagation(); eliminarClienteIndividual(c); }}
                            title="Eliminar cliente ocasional sin deuda"
                            style={{ padding: '4px 6px', color: 'var(--danger)' }}
                          >
                            <Trash2 size={14} strokeWidth={1.75} />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {clientes.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  {todosLosClientes.length === 0
                    ? 'Todavía no hay clientes registrados (aparecen solos cuando cotizan por WhatsApp).'
                    : pestana === 'cuenta_corriente'
                      ? 'Ningún cliente pidió cuenta corriente todavía.'
                      : 'No hay clientes ocasionales por ahora.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
