import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, X, Download, Pencil, Send, Plus } from 'lucide-react';
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
  const [editandoPlan, setEditandoPlan] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState('');
  const [pestana, setPestana] = useState<Pestana>('cuenta_corriente');
  const [enviando, setEnviando] = useState<string | null>(null);
  const [mostrarAlta, setMostrarAlta] = useState(false);
  const [altaForm, setAltaForm] = useState<{ nombre: string; telefono: string; tipo: 'cuenta_corriente' | 'ocasional' }>(
    { nombre: '', telefono: '', tipo: 'cuenta_corriente' },
  );
  const [creando, setCreando] = useState(false);

  const { data: todosLosClientes = [] } = useQuery({
    queryKey: ['clientes'],
    queryFn: () => api.get<Cliente[]>('/api/clientes').then((r) => r.data),
  });
  const clientesCC = todosLosClientes.filter(esCuentaCorriente);
  const clientesOcasionales = todosLosClientes.filter((c) => !esCuentaCorriente(c));
  const clientes = pestana === 'cuenta_corriente' ? clientesCC : clientesOcasionales;

  async function cambiarCuentaCorriente(id: string, estado: Cliente['cuenta_corriente_estado']) {
    try {
      await api.patch(`/api/clientes/${id}`, { cuenta_corriente_estado: estado });
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      show('success', estado === 'aprobada' ? 'Cuenta corriente aprobada' : 'Cuenta corriente rechazada');
    } catch {
      show('error', 'No se pudo actualizar la cuenta corriente');
    }
  }

  async function enviarPorWhatsApp(telefono: string) {
    setEnviando(telefono);
    try {
      await api.post(`/api/clientes/${encodeURIComponent(telefono)}/enviar-excel`);
      show('success', 'Enviado por WhatsApp', telefono);
    } catch (err: any) {
      show('error', 'No se pudo enviar', err.response?.data?.error);
    } finally {
      setEnviando(null);
    }
  }

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

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
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
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Teléfono</th>
              <th>Nº plan</th>
              <th>Pedidos</th>
              <th>Deuda</th>
              {pestana === 'cuenta_corriente' && <th>Acciones</th>}
              {pestana === 'cuenta_corriente' && <th></th>}
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
                  <td>{c.telefono}</td>
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
                      debe
                        ? <span className="badge rechazado">Sí · ${Number(c.deuda).toLocaleString('es-AR')}</span>
                        : <span className="badge disponible">No</span>
                    )}
                  </td>
                  {pestana === 'cuenta_corriente' && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <RoleGate roles={['admin', 'operador', 'finanzas']}>
                        {c.cuenta_corriente_estado === 'pendiente' && (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button onClick={() => cambiarCuentaCorriente(c.id, 'aprobada')} className="btn btn-success btn-sm">
                              <Check strokeWidth={2} /> Aprobar
                            </button>
                            <button onClick={() => cambiarCuentaCorriente(c.id, 'rechazada')} className="btn btn-danger btn-sm">
                              <X strokeWidth={2} /> Rechazar
                            </button>
                          </div>
                        )}
                        {c.cuenta_corriente_estado === 'aprobada' && (
                          <button onClick={() => cambiarCuentaCorriente(c.id, 'rechazada')} className="btn btn-danger btn-sm">
                            <X strokeWidth={2} /> Dar de baja
                          </button>
                        )}
                      </RoleGate>
                    </td>
                  )}
                  {pestana === 'cuenta_corriente' && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <RoleGate roles={['admin', 'operador', 'finanzas']}>
                        <button
                          className="btn btn-ghost btn-sm"
                          title="Enviar su Excel de movimientos por WhatsApp"
                          onClick={() => enviarPorWhatsApp(c.telefono)}
                          disabled={enviando === c.telefono}
                        >
                          <Send size={13} strokeWidth={1.75} /> {enviando === c.telefono ? '...' : 'Enviar'}
                        </button>
                      </RoleGate>
                    </td>
                  )}
                </tr>
              );
            })}
            {clientes.length === 0 && (
              <tr>
                <td colSpan={pestana === 'cuenta_corriente' ? 7 : 5} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
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
