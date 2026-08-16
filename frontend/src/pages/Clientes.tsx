import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, X, Download, Pencil, ArrowRight } from 'lucide-react';
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
  ultimo_viaje: string | null;
}

const ETIQUETA_CC: Record<Cliente['cuenta_corriente_estado'], { texto: string; clase: string }> = {
  sin_pedir: { texto: 'Sin pedir', clase: 'retirado' },
  pendiente: { texto: 'Pendiente', clase: 'pendiente' },
  aprobada: { texto: 'Aprobada', clase: 'disponible' },
  rechazada: { texto: 'Rechazada', clase: 'rechazado' },
};

export function Clientes() {
  const { show } = useToast();
  const { user } = useAuth();
  const puedeEditarPlan = tieneRol(user, 'admin', 'operador', 'finanzas');
  const queryClient = useQueryClient();
  const [editandoPlan, setEditandoPlan] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState('');

  const { data: clientes = [] } = useQuery({
    queryKey: ['clientes'],
    queryFn: () => api.get<Cliente[]>('/api/clientes').then((r) => r.data),
  });

  async function cambiarCuentaCorriente(id: string, estado: Cliente['cuenta_corriente_estado']) {
    try {
      await api.patch(`/api/clientes/${id}`, { cuenta_corriente_estado: estado });
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      show('success', estado === 'aprobada' ? 'Cuenta corriente aprobada' : 'Cuenta corriente rechazada');
    } catch {
      show('error', 'No se pudo actualizar la cuenta corriente');
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

      <div className="form-card" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          className="btn btn-primary"
          onClick={() => descargarArchivo('/api/clientes/export.xlsx', 'clientes.xlsx')}
        >
          <Download strokeWidth={1.75} /> Exportar todo a Excel
        </button>
        <small className="text-muted">Sale seccionado en una hoja por mes, con todos los clientes.</small>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Teléfono</th>
              <th>Nº plan</th>
              <th>Cuenta corriente</th>
              <th>Viajes</th>
              <th>Último viaje</th>
              <th>Acciones</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clientes.map((c) => {
              const cc = ETIQUETA_CC[c.cuenta_corriente_estado];
              return (
                <tr key={c.id}>
                  <td className="strong">{c.nombre}</td>
                  <td>{c.telefono}</td>
                  <td className="mono">
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
                  <td><span className={`badge ${cc.clase}`}>{cc.texto}</span></td>
                  <td>{c.cantidad_viajes}</td>
                  <td>{c.ultimo_viaje ? new Date(c.ultimo_viaje).toLocaleDateString('es-AR') : <span className="text-muted">—</span>}</td>
                  <td>
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
                    </RoleGate>
                  </td>
                  <td>
                    <Link to={`/clientes/${encodeURIComponent(c.telefono)}`} className="btn btn-ghost btn-sm">
                      Ingresar <ArrowRight size={13} strokeWidth={1.75} />
                    </Link>
                  </td>
                </tr>
              );
            })}
            {clientes.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  Todavía no hay clientes registrados (aparecen solos cuando cotizan por WhatsApp).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
