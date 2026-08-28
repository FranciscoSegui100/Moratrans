import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Send, Pencil, X, Wallet, Receipt, CircleDollarSign, Plus, Trash2 } from 'lucide-react';
import { api, descargarArchivo } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { DireccionMaps } from '../components/DireccionMaps';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { useAuth, tieneRol } from '../context/AuthContext';
import { formatearFecha } from '../lib/fechas';

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

interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  cuenta_corriente_estado: 'sin_pedir' | 'pendiente' | 'aprobada' | 'rechazada';
  numero_plan: number | null;
}

interface ItemCuentaCorriente {
  fecha: string;
  zona: string | null;
  monto: string | null;
}

interface AbonoCuentaCorriente {
  id: string;
  fecha: string;
  monto: string | null;
}

interface ResumenCuentaCorriente {
  cargos: ItemCuentaCorriente[];
  abonos: AbonoCuentaCorriente[];
  totalCargos: number;
  totalAbonos: number;
  saldo: number;
}

interface ViajeCliente {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  estado: string;
  zona: string | null;
  contenedor_numero?: string | null;
  destino_direccion: string | null;
  destino_lat?: string | null;
  destino_lng?: string | null;
  patente: string | null;
  remito: string | null;
  importe: string | null;
  grupo_id: string | null;
  chofer_nombre: string | null;
  es_cuenta_corriente?: boolean;
  comprobantes?: Comprobante[];
}

const ETIQUETA_CC: Record<Cliente['cuenta_corriente_estado'], { texto: string; clase: string }> = {
  sin_pedir: { texto: 'Sin pedir', clase: 'retirado' },
  pendiente: { texto: 'Pendiente', clase: 'pendiente' },
  aprobada: { texto: 'Aprobada', clase: 'disponible' },
  rechazada: { texto: 'Rechazada', clase: 'rechazado' },
};

/** Mismo criterio que excelClientes() en el backend — mantener en sync. */
function tipoBulto(v: ViajeCliente): string {
  if (v.tipo === 'entrega') return 'VACIO';
  if (v.grupo_id) return 'Recambio';
  return 'Retiro';
}

function etiquetaMes(mes: string): string {
  const [anio, m] = mes.split('-');
  const texto = new Date(Number(anio), Number(m) - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

export function ClienteDetalle() {
  const { telefono = '' } = useParams<{ telefono: string }>();
  const { show } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const puedeEditarRemito = tieneRol(user, 'admin', 'operador', 'finanzas');
  const [enviando, setEnviando] = useState(false);
  const [editandoRemito, setEditandoRemito] = useState<string | null>(null);
  const [remitoForm, setRemitoForm] = useState('');
  const [viajeComprobantes, setViajeComprobantes] = useState<ViajeCliente | null>(null);
  const [reenviando, setReenviando] = useState<string | null>(null);
  const [editandoAbono, setEditandoAbono] = useState<string | null>(null);
  const [montoAbonoForm, setMontoAbonoForm] = useState('');
  const [agregandoPago, setAgregandoPago] = useState(false);
  const [montoPagoForm, setMontoPagoForm] = useState('');
  const [guardandoPago, setGuardandoPago] = useState(false);

  /**
   * Para el caso borde en que un pago (o alargue) quedó validado pero el
   * WhatsApp de confirmación nunca le llegó al cliente — reintenta solo el
   * envío, sin tocar nada ya grabado.
   */
  async function reenviarAviso(pagoId: string) {
    setReenviando(pagoId);
    try {
      await api.post(`/api/pagos/${pagoId}/reenviar-aviso`);
      show('success', 'Aviso reenviado por WhatsApp');
    } catch (err: any) {
      show('error', 'No se pudo reenviar', err.response?.data?.error);
    } finally {
      setReenviando(null);
    }
  }

  async function guardarRemito(viajeId: string) {
    try {
      await api.patch(`/api/viajes/${viajeId}`, { remito: remitoForm.trim() || null });
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'viajes'] });
      setEditandoRemito(null);
      show('success', 'Nº de remito actualizado');
    } catch (err: any) {
      show('error', 'No se pudo guardar', err.response?.data?.error);
    }
  }

  /** Corrige el monto de un abono ya validado (ver POST /api/pagos/:id/monto) — para cuando el operador se equivocó al tipearlo. */
  async function guardarMontoAbono(abonoId: string) {
    const monto = Number(montoAbonoForm);
    if (!(monto > 0)) return show('error', 'Monto inválido');
    try {
      await api.patch(`/api/pagos/${abonoId}/monto`, { monto });
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'cuenta-corriente'] });
      setEditandoAbono(null);
      show('success', 'Monto corregido');
    } catch (err: any) {
      show('error', 'No se pudo guardar', err.response?.data?.error);
    }
  }

  /** Borra un abono cargado por error (ver DELETE /api/pagos/:id) — solo pagos, nunca cobros. */
  async function eliminarAbono(abonoId: string, monto: number) {
    if (!confirm(`¿Eliminar este pago de $${monto.toLocaleString('es-AR')}? Se vuelve a sumar al saldo pendiente.`)) return;
    try {
      await api.delete(`/api/pagos/${abonoId}`);
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'cuenta-corriente'] });
      show('success', 'Pago eliminado');
    } catch (err: any) {
      show('error', 'No se pudo eliminar', err.response?.data?.error);
    }
  }

  /** Pago que no pasó por WhatsApp (ej. efectivo en mano) — se acredita directo, sin comprobante. */
  async function agregarPagoManual() {
    const monto = Number(montoPagoForm);
    if (!(monto > 0)) return show('error', 'Monto inválido');
    setGuardandoPago(true);
    try {
      await api.post('/api/pagos/abono-manual', { telefono, monto });
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'cuenta-corriente'] });
      setAgregandoPago(false);
      setMontoPagoForm('');
      show('success', 'Pago acreditado a la cuenta corriente');
    } catch (err: any) {
      show('error', 'No se pudo guardar', err.response?.data?.error);
    } finally {
      setGuardandoPago(false);
    }
  }

  /** Mismo PDF que el cliente puede pedir él mismo con "📊 Resumen de cuenta" por WhatsApp (ver movimientos.flow.ts). */
  async function enviarResumenPorWhatsApp() {
    setEnviando(true);
    try {
      await api.post(`/api/clientes/${encodeURIComponent(telefono)}/enviar-resumen-cuenta`);
      show('success', 'Enviado por WhatsApp', telefono);
    } catch (err: any) {
      show('error', 'No se pudo enviar', err.response?.data?.error);
    } finally {
      setEnviando(false);
    }
  }

  const { data: clientes = [] } = useQuery({
    queryKey: ['clientes'],
    queryFn: () => api.get<Cliente[]>('/api/clientes').then((r) => r.data),
  });
  const cliente = clientes.find((c) => c.telefono === telefono);

  const { data: viajesReales = [] } = useQuery({
    queryKey: ['clientes', telefono, 'viajes'],
    queryFn: () => api.get<ViajeCliente[]>(`/api/clientes/${encodeURIComponent(telefono)}/viajes`).then((r) => r.data),
    enabled: !!telefono,
  });
  const esCC = cliente?.cuenta_corriente_estado === 'aprobada' || cliente?.cuenta_corriente_estado === 'pendiente';

  const { data: cuentaCorriente } = useQuery({
    queryKey: ['clientes', telefono, 'cuenta-corriente'],
    queryFn: () => api.get<ResumenCuentaCorriente>(`/api/clientes/${encodeURIComponent(telefono)}/cuenta-corriente`).then((r) => r.data),
    enabled: !!telefono && esCC,
  });
  const viajes = viajesReales;

  // Ya vienen ordenados por fecha DESC desde el backend: agrupar preservando
  // ese orden deja los meses más recientes arriba sin tener que reordenar.
  const grupos = useMemo(() => {
    const porMes = new Map<string, ViajeCliente[]>();
    for (const v of viajes) {
      const mes = v.fecha.slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, []);
      porMes.get(mes)!.push(v);
    }
    return [...porMes.entries()];
  }, [viajes]);

  const cc = cliente ? ETIQUETA_CC[cliente.cuenta_corriente_estado] : null;

  return (
    <div>
      <div className="page-header">
        <Link to="/clientes" className="btn btn-ghost btn-sm" style={{ marginBottom: '10px' }}>
          <ArrowLeft size={14} strokeWidth={1.75} /> Volver a Clientes
        </Link>
        <h2>{cliente?.nombre ?? telefono}</h2>
        <p>
          {telefono}
          {cliente?.numero_plan != null && <> · Nº plan {cliente.numero_plan}</>}
          {cc && <> · <span className={`badge ${cc.clase}`}>{cc.texto}</span></>}
        </p>
      </div>

      <div className="form-card" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          className="btn btn-primary"
          onClick={() => descargarArchivo(`/api/clientes/export.xlsx?telefono=${encodeURIComponent(telefono)}`, `${cliente?.nombre ?? telefono}.xlsx`)}
        >
          <Download strokeWidth={1.75} /> Exportar a Excel
        </button>
        <RoleGate roles={['admin', 'operador', 'finanzas']}>
          <button className="btn btn-ghost" onClick={enviarResumenPorWhatsApp} disabled={enviando}>
            <Send strokeWidth={1.75} /> {enviando ? 'Enviando...' : 'Enviar resumen de cuenta por WhatsApp'}
          </button>
        </RoleGate>
      </div>

      {esCC && cuentaCorriente && (
        <div style={{ marginTop: '20px' }}>
          <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Cuenta corriente</span>
            <RoleGate roles={['admin', 'operador', 'finanzas']}>
              {agregandoPago ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="form-input"
                    style={{ width: '140px', padding: '4px 8px' }}
                    placeholder="Monto"
                    value={montoPagoForm}
                    onChange={(e) => setMontoPagoForm(e.target.value)}
                    autoFocus
                  />
                  <button className="btn btn-success btn-sm" onClick={agregarPagoManual} disabled={guardandoPago}>OK</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setAgregandoPago(false); setMontoPagoForm(''); }}>✕</button>
                </div>
              ) : (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setAgregandoPago(true)}
                  title="Para pagos que no pasaron por WhatsApp, ej. efectivo en mano"
                >
                  <Plus size={12} strokeWidth={1.75} /> Agregar pago manual
                </button>
              )}
            </RoleGate>
          </div>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-icon"><Receipt strokeWidth={1.75} /></div>
              <div className="kpi-value">${cuentaCorriente.totalCargos.toLocaleString('es-AR')}</div>
              <div className="kpi-label">Deuda acumulada</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-icon"><Wallet strokeWidth={1.75} /></div>
              <div className="kpi-value">${cuentaCorriente.totalAbonos.toLocaleString('es-AR')}</div>
              <div className="kpi-label">Pagado</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-icon"><CircleDollarSign strokeWidth={1.75} /></div>
              <div className="kpi-value">${cuentaCorriente.saldo.toLocaleString('es-AR')}</div>
              <div className="kpi-label">Saldo pendiente</div>
            </div>
          </div>

          {(cuentaCorriente.cargos.length > 0 || cuentaCorriente.abonos.length > 0) && (
            <div className="table-wrapper" style={{ marginTop: '12px' }}>
              <table className="data-table">
                <thead>
                  <tr><th>FECHA</th><th>MOVIMIENTO</th><th>MONTO</th></tr>
                </thead>
                <tbody>
                  {[
                    ...cuentaCorriente.cargos.map((c) => ({ id: null as string | null, fecha: c.fecha, texto: c.zona ?? 'Sin zona', monto: c.monto ? Number(c.monto) : 0, signo: 1 })),
                    ...cuentaCorriente.abonos.map((a) => ({ id: a.id, fecha: a.fecha, texto: 'Pago acreditado', monto: a.monto ? Number(a.monto) : 0, signo: -1 })),
                  ]
                    .sort((a, b) => a.fecha.localeCompare(b.fecha))
                    .reverse()
                    .map((m, i) => (
                      <tr key={i}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatearFecha(m.fecha)}</td>
                        <td>{m.signo > 0 ? m.texto : <span style={{ color: 'var(--color-success, #16a34a)' }}>{m.texto}</span>}</td>
                        <td>
                          {m.id !== null && editandoAbono === m.id ? (
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                className="form-input"
                                style={{ width: '110px', padding: '4px 8px' }}
                                value={montoAbonoForm}
                                onChange={(e) => setMontoAbonoForm(e.target.value)}
                                autoFocus
                              />
                              <button className="btn btn-success btn-sm" onClick={() => guardarMontoAbono(m.id!)}>OK</button>
                              <button className="btn btn-ghost btn-sm" onClick={() => setEditandoAbono(null)}>✕</button>
                            </div>
                          ) : (
                            <>
                              {m.signo > 0 ? '' : '− '}${m.monto.toLocaleString('es-AR')}
                              {m.id && (
                                <RoleGate roles={['admin', 'operador', 'finanzas']}>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    style={{ marginLeft: '6px' }}
                                    onClick={() => { setEditandoAbono(m.id); setMontoAbonoForm(String(m.monto)); }}
                                    title="Corregir el monto de este pago"
                                  >
                                    <Pencil size={11} strokeWidth={1.75} />
                                  </button>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => eliminarAbono(m.id!, m.monto)}
                                    title="Eliminar este pago"
                                  >
                                    <Trash2 size={11} strokeWidth={1.75} />
                                  </button>
                                </RoleGate>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {grupos.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-title">Sin viajes registrados</div>
          </div>
        </div>
      ) : (
        grupos.map(([mes, viajesDelMes]) => (
          <div key={mes} style={{ marginTop: '20px' }}>
            <div className="section-title">{etiquetaMes(mes)}</div>
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>FECHA</th><th>CHA/EQU</th><th>PAT</th><th>POSICIÓN</th>
                    <th>TIPO BULTO</th><th>CANTIDAD</th><th>Nº REMITO</th>
                    <th>IMPORTE</th><th>COMPROBANTES</th><th>CHOFER</th><th>ESTADO</th>
                  </tr>
                </thead>
                <tbody>
                  {viajesDelMes.map((v) => (
                    <tr key={v.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatearFecha(v.fecha)}</td>
                      <td>Contenedor</td>
                      <td className="mono">{v.patente ?? '—'}</td>
                      <td>
                        {v.destino_direccion
                          ? <DireccionMaps direccion={v.destino_direccion} lat={v.destino_lat} lng={v.destino_lng} />
                          : (v.zona ?? '—')}
                      </td>
                      <td>{tipoBulto(v)}</td>
                      <td>1</td>
                      <td className="mono">
                        {editandoRemito === v.id ? (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input
                              className="form-input"
                              style={{ width: '90px', padding: '4px 8px' }}
                              value={remitoForm}
                              onChange={(e) => setRemitoForm(e.target.value)}
                              autoFocus
                            />
                            <button className="btn btn-success btn-sm" onClick={() => guardarRemito(v.id)}>OK</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setEditandoRemito(null)}>✕</button>
                          </div>
                        ) : puedeEditarRemito ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => { setEditandoRemito(v.id); setRemitoForm(v.remito ?? ''); }}
                          >
                            {v.remito ?? <span className="text-muted">Asignar</span>} <Pencil size={11} strokeWidth={1.75} />
                          </button>
                        ) : (
                          v.remito ?? '—'
                        )}
                      </td>
                      <td>{v.importe ? `$${Number(v.importe).toLocaleString('es-AR')}` : <span className="text-muted">—</span>}</td>
                      <td>
                        {(() => {
                          const comprobantes = v.comprobantes ?? [];
                          const inicial = comprobantes.find((c) => c.tipo !== 'alargue_retiro');
                          const esCC = v.es_cuenta_corriente || inicial?.es_cuenta_corriente;
                          if (!esCC && !inicial) {
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
                            </div>
                          );
                        })()}
                      </td>
                      <td>{v.chofer_nombre ?? '—'}</td>
                      <td><span className={`badge ${v.estado}`}>{v.estado}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
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
              {formatearFecha(viajeComprobantes.fecha)} · {viajeComprobantes.destino_direccion ?? viajeComprobantes.zona ?? '—'}
            </p>
            {(viajeComprobantes.comprobantes ?? []).length === 0 && (
              <p className="text-muted">Sin comprobantes asociados a este viaje.</p>
            )}
            {(viajeComprobantes.comprobantes ?? []).map((c) => (
              <div key={c.id} style={{ marginBottom: 18 }}>
                <div className="section-title" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>
                    {c.tipo === 'alargue_retiro' ? '⏳ Extensión de retiro' : '🧾 Pago inicial'}
                    {c.monto && ` · $${Number(c.monto).toLocaleString('es-AR')}`}
                    {' · '}<span className={`badge ${c.estado}`}>{c.estado}</span>
                  </span>
                  {c.estado === 'validado' && (
                    <RoleGate roles={['admin', 'operador', 'finanzas']}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => reenviarAviso(c.id)}
                        disabled={reenviando === c.id}
                        title="Si el cliente dice que todavía no le llegó la confirmación por WhatsApp"
                      >
                        <Send size={12} strokeWidth={1.75} /> Reenviar aviso
                      </button>
                    </RoleGate>
                  )}
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
