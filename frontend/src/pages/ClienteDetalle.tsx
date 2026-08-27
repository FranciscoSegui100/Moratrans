import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Send, Pencil, X } from 'lucide-react';
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

  async function enviarPorWhatsApp() {
    setEnviando(true);
    try {
      await api.post(`/api/clientes/${encodeURIComponent(telefono)}/enviar-excel`);
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
          <button className="btn btn-ghost" onClick={enviarPorWhatsApp} disabled={enviando}>
            <Send strokeWidth={1.75} /> {enviando ? 'Enviando...' : 'Enviar por WhatsApp'}
          </button>
        </RoleGate>
      </div>

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
                          const extensiones = comprobantes.filter((c) => c.tipo === 'alargue_retiro');
                          const esCC = v.es_cuenta_corriente || inicial?.es_cuenta_corriente;
                          if (!esCC && !inicial && extensiones.length === 0) {
                            return <span className="text-muted">—</span>;
                          }
                          return (
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                              {esCC ? (
                                <span className="badge pendiente">📋 Cuenta corriente</span>
                              ) : inicial && (
                                <button className="btn btn-ghost btn-sm" onClick={() => setViajeComprobantes(v)}>
                                  🧾 Inicial
                                </button>
                              )}
                              {extensiones.length > 0 && (
                                <button className="btn btn-ghost btn-sm" onClick={() => setViajeComprobantes(v)}>
                                  ⏳ Extensión{extensiones.length > 1 ? ` (${extensiones.length})` : ''}
                                </button>
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
