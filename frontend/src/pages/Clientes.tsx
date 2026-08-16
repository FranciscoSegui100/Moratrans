import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Check, X, Download } from 'lucide-react';
import { api, descargarArchivo } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  cuenta_corriente_estado: 'sin_pedir' | 'pendiente' | 'aprobada' | 'rechazada';
  cantidad_viajes: number;
  ultimo_viaje: string | null;
}

interface ViajeCliente {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  estado: string;
  zona: string | null;
  contenedor_numero: string | null;
  patente: string | null;
  chofer_nombre: string | null;
}

const ETIQUETA_CC: Record<Cliente['cuenta_corriente_estado'], { texto: string; clase: string }> = {
  sin_pedir: { texto: 'Sin pedir', clase: 'retirado' },
  pendiente: { texto: 'Pendiente', clase: 'pendiente' },
  aprobada: { texto: 'Aprobada', clase: 'disponible' },
  rechazada: { texto: 'Rechazada', clase: 'rechazado' },
};

export function Clientes() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [mes, setMes] = useState('');
  const [expandido, setExpandido] = useState<string | null>(null);

  const { data: clientes = [] } = useQuery({
    queryKey: ['clientes'],
    queryFn: () => api.get<Cliente[]>('/api/clientes').then((r) => r.data),
  });

  const { data: viajesCliente = [] } = useQuery({
    queryKey: ['clientes', expandido, 'viajes', mes],
    queryFn: () =>
      api
        .get<ViajeCliente[]>(`/api/clientes/${encodeURIComponent(expandido!)}/viajes`, { params: mes ? { mes } : {} })
        .then((r) => r.data),
    enabled: !!expandido,
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

  return (
    <div>
      <div className="page-header">
        <h2>Clientes</h2>
        <p>Padrón de clientes, cuenta corriente y viajes por mes</p>
      </div>

      <div className="form-card" style={{ display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Filtrar por mes</label>
          <input type="month" className="form-input" value={mes} onChange={(e) => setMes(e.target.value)} />
        </div>
        <button
          className="btn btn-primary"
          onClick={() => descargarArchivo(`/api/clientes/export.xlsx${mes ? `?mes=${mes}` : ''}`, 'clientes.xlsx')}
        >
          <Download strokeWidth={1.75} /> Exportar a Excel
        </button>
        {!mes && <small className="text-muted">Sin mes elegido, el Excel sale seccionado en una hoja por mes.</small>}
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th></th>
              <th>Cliente</th>
              <th>Teléfono</th>
              <th>Cuenta corriente</th>
              <th>Viajes</th>
              <th>Último viaje</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {clientes.map((c) => {
              const abierto = expandido === c.telefono;
              const cc = ETIQUETA_CC[c.cuenta_corriente_estado];
              return (
                <>
                  <tr key={c.id}>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => setExpandido(abierto ? null : c.telefono)}>
                        {abierto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="strong">{c.nombre}</td>
                    <td>{c.telefono}</td>
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
                  </tr>
                  {abierto && (
                    <tr key={`${c.id}-detalle`}>
                      <td colSpan={7} style={{ padding: 0 }}>
                        <div style={{ padding: '12px 16px', background: 'var(--bg-surface)' }}>
                          {viajesCliente.length === 0 ? (
                            <span className="text-muted">Sin viajes {mes ? 'en ese mes' : 'registrados'}.</span>
                          ) : (
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Fecha</th><th>Tipo</th><th>Contenedor</th><th>Zona</th>
                                  <th>Chofer</th><th>Patente</th><th>Estado</th>
                                </tr>
                              </thead>
                              <tbody>
                                {viajesCliente.map((v) => (
                                  <tr key={v.id}>
                                    <td>{v.fecha}</td>
                                    <td>{v.tipo}</td>
                                    <td className="mono">{v.contenedor_numero ?? '—'}</td>
                                    <td>{v.zona ?? '—'}</td>
                                    <td>{v.chofer_nombre ?? '—'}</td>
                                    <td className="mono">{v.patente ?? '—'}</td>
                                    <td><span className={`badge ${v.estado}`}>{v.estado}</span></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {clientes.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
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
