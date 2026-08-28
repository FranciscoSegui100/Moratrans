import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Check, X, RotateCcw, CircleCheck } from 'lucide-react';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';
import { RoleGate } from '../components/RoleGate';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { useToast } from '../components/Toast';
import { formatearFecha, formatearFechaHora } from '../lib/fechas';

interface Pago {
  id: string;
  cliente_telefono: string;
  monto: string | null;
  url_comprobante: string | null;
  estado: string;
  zona: string | null;
  precio: string | null;
  moneda: string | null;
  creado_en: string;
  adjuntos_count: number;
  titular_transferencia: string | null;
  es_cuenta_corriente: boolean;
  tipo: 'flete' | 'alargue_retiro' | 'abono_cc';
  contenedor_numero: string | null;
}

interface Adjunto { id: string; creado_en: string; }

/**
 * Comprobantes adicionales de un pago (llegaron después del primero porque
 * el cliente reenvió el pago de la misma cotización — sección 23, caso
 * borde de comprobante duplicado). Se cargan aparte para no pedirlos si no
 * hay ninguno.
 */
function AdjuntosPago({ pagoId }: { pagoId: string }) {
  const { data: adjuntos = [] } = useQuery({
    queryKey: ['pagos', pagoId, 'adjuntos'],
    queryFn: () => api.get<Adjunto[]>(`/api/pagos/${pagoId}/adjuntos`).then((r) => r.data),
  });
  if (adjuntos.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
      <span className="text-muted">Comprobantes adicionales de esta solicitud:</span>
      {adjuntos.map((a) => (
        <ComprobanteViewer key={a.id} pagoId={pagoId} adjuntoId={a.id} />
      ))}
    </div>
  );
}

export function Pagos() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [procesando, setProcesando] = useState<string | null>(null);
  // Monto que el operador tipea para acreditar un abono de cuenta corriente
  // (el cliente no lo declara, ver pago.flow.ts) — uno por pago pendiente.
  const [montosAbono, setMontosAbono] = useState<Record<string, string>>({});

  const { data: pagos = [] } = useQuery({
    queryKey: ['pagos', 'pendiente'],
    queryFn: () => api.get<Pago[]>('/api/pagos?estado=pendiente').then((r) => r.data),
  });

  const cargar = () => queryClient.invalidateQueries({ queryKey: ['pagos', 'pendiente'] });

  // Cuando OTRO operador valida/rechaza un pago desde acá o desde Alertas,
  // esto lo saca de esta lista en vivo — sin esto, cada quien solo veía
  // reflejadas sus propias acciones hasta hacer F5.
  useEffect(() => {
    const socket = conectarSocket();
    const onAlertaActualizada = (p: { tipo: string; estado: string }) => {
      if ((p.tipo === 'pago_pendiente_validacion' || p.tipo === 'cuenta_corriente_solicitada') && p.estado === 'resuelta') cargar();
    };
    socket.on('alerta_actualizada', onAlertaActualizada);
    return () => { socket.off('alerta_actualizada', onAlertaActualizada); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // La logística (chofer, contenedor) se arma un día antes desde la
  // pestaña Viajes — acá solo se confirma el pago, y de ahí se manda directo.
  async function validar(id: string, body: Record<string, unknown> = {}) {
    setProcesando(id);
    try {
      const { data } = await api.post(`/api/pagos/${id}/validar`, body);
      show(
        'success',
        data.tipo === 'alargue_retiro' ? 'Alargue validado' : data.tipo === 'abono_cc' ? 'Abono acreditado' : 'Pago validado',
        data.tipo === 'alargue_retiro'
          ? `Contenedor ${data.contenedor} — nuevo vencimiento ${formatearFecha(data.vence_en)}`
          : data.tipo === 'abono_cc'
          ? `Se acreditaron $${Number(data.monto).toLocaleString('es-AR')} a la cuenta corriente`
          : data.reservado_ahora
          ? `Ticket ${data.ticket_id} — contenedor ${data.contenedor}`
          : `Ticket ${data.ticket_id} — contenedor ${data.contenedor} reservado a futuro, todavía está ocupado`,
      );
      setMontosAbono((prev) => { const { [id]: _, ...resto } = prev; return resto; });
      cargar();
    } catch (e: any) {
      show('error', 'Error al validar', e.response?.data?.error || 'Error desconocido');
    } finally {
      setProcesando(null);
    }
  }

  async function rechazar(id: string) {
    const motivo = prompt('Motivo del rechazo:') || 'Comprobante no válido';
    setProcesando(id);
    try {
      await api.post(`/api/pagos/${id}/rechazar`, { motivo });
      show('info', 'Pago rechazado', motivo);
      cargar();
    } catch {
      show('error', 'Error al rechazar');
    } finally {
      setProcesando(null);
    }
  }

  /** No es un rechazo real: le pide al cliente que reenvíe el comprobante (ej. foto no legible). */
  async function pedirDeNuevo(id: string) {
    setProcesando(id);
    try {
      await api.post(`/api/pagos/${id}/rechazar`, {
        motivo: 'Comprobante no legible. Por favor, enviá una foto más clara.',
      });
      show('info', 'Le pedimos al cliente que reenvíe el comprobante', 'Se le avisó por WhatsApp');
      cargar();
    } catch {
      show('error', 'No se pudo avisar al cliente');
    } finally {
      setProcesando(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Validación de pagos</h2>
        <p>Revisá los comprobantes y aprobá o rechazá cada pago pendiente</p>
      </div>

      {pagos.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><CircleCheck strokeWidth={1.5} /></div>
            <div className="empty-state-title">Todo al día</div>
            <div className="empty-state-text">No hay pagos pendientes de validación</div>
          </div>
        </div>
      ) : (
        <div className="space-y">
          {pagos.map((p) => (
            <div key={p.id} className="pago-card">
              <div className="pago-card-top">
                <div className="pago-avatar"><CreditCard strokeWidth={1.75} /></div>

                <div className="pago-info">
                  <div className="pago-phone">{p.cliente_telefono}</div>
                  {p.tipo === 'alargue_retiro' ? (
                    <div className="pago-detail">
                       ⏳ Alargue de retiro — contenedor <strong>{p.contenedor_numero ?? '—'}</strong> ·{' '}
                      {p.monto ? `${p.moneda ?? ''} ${Number(p.monto).toLocaleString('es-AR')}`.trim() : 'Sin monto'} ·{' '}
                      {formatearFechaHora(p.creado_en)}
                    </div>
                  ) : p.tipo === 'abono_cc' ? (
                    <div className="pago-detail">
                      💳 Abono a cuenta corriente · {formatearFechaHora(p.creado_en)}
                    </div>
                  ) : (
                    <div className="pago-detail">
                      {p.zona ?? 'Sin zona'} ·{' '}
                      {p.precio ? `${p.moneda ?? ''} ${Number(p.precio).toLocaleString('es-AR')}`.trim() : 'Sin monto'} ·{' '}
                      {formatearFechaHora(p.creado_en)}
                    </div>
                  )}
                  {p.titular_transferencia && (
                    <div className="pago-detail">Transferencia a nombre de: <strong>{p.titular_transferencia}</strong></div>
                  )}
                  {p.tipo === 'abono_cc' && (
                    <RoleGate roles={['admin', 'operador', 'finanzas']}>
                      <div className="pago-detail" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                        <span>Monto a acreditar:</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="form-input"
                          style={{ width: '140px', padding: '4px 8px' }}
                          placeholder="$"
                          value={montosAbono[p.id] ?? ''}
                          onChange={(e) => setMontosAbono((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        />
                      </div>
                    </RoleGate>
                  )}
                  <RoleGate roles={['admin', 'finanzas']}>
                    {p.url_comprobante ? (
                      <ComprobanteViewer pagoId={p.id} />
                    ) : p.es_cuenta_corriente ? (
                      <span className="badge pendiente">📋 Cuenta corriente — sin comprobante</span>
                    ) : (
                      <span className="text-muted">Sin comprobante</span>
                    )}
                    {p.adjuntos_count > 0 && <AdjuntosPago pagoId={p.id} />}
                  </RoleGate>
                </div>

                <div className="pago-actions">
                  <RoleGate roles={['admin', 'operador', 'finanzas']}>
                    <button
                      onClick={() => (p.tipo === 'abono_cc' ? validar(p.id, { monto: Number(montosAbono[p.id]) }) : validar(p.id))}
                      className="btn btn-success btn-sm"
                      disabled={procesando === p.id || (p.tipo === 'abono_cc' && !(Number(montosAbono[p.id]) > 0))}
                    >
                      <Check strokeWidth={2} /> Validar
                    </button>
                    <button
                      onClick={() => rechazar(p.id)}
                      className="btn btn-danger btn-sm"
                      disabled={procesando === p.id}
                    >
                      <X strokeWidth={2} /> Rechazar
                    </button>
                    <button
                      onClick={() => pedirDeNuevo(p.id)}
                      className="btn btn-ghost btn-sm"
                      disabled={procesando === p.id}
                      title="El comprobante no se lee bien: le pedimos al cliente que lo reenvíe"
                    >
                      <RotateCcw strokeWidth={1.75} /> Pedir de nuevo
                    </button>
                  </RoleGate>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
