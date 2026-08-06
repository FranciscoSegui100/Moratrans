import { useEffect, useState } from 'react';
import { Check, X, RotateCcw, CircleCheck, FileCheck } from 'lucide-react';
import { useAlertas } from '../hooks/useAlertas';
import { RoleGate } from '../components/RoleGate';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { ChatAsesor } from '../components/ChatAsesor';
import { ValidarPagoForm, ValidarPagoPayload } from '../components/ValidarPagoForm';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import { tipoLabel } from '../lib/alertLabels';

interface Chofer { id: string; nombre: string; activo: boolean; }

export function Alertas() {
  const { alertas, resolver, validarPago, rechazarPago, confirmarRetiro, enviarFactura } = useAlertas();
  const { show } = useToast();
  const [procesando, setProcesando] = useState<string | null>(null);
  const [validandoId, setValidandoId] = useState<string | null>(null);
  const [choferes, setChoferes] = useState<Chofer[]>([]);
  const [facturaFile, setFacturaFile] = useState<Record<string, File | undefined>>({});

  useEffect(() => {
    api.get<Chofer[]>('/api/choferes').then((r) => setChoferes(r.data.filter((c) => c.activo))).catch(() => {});
  }, []);

  async function onValidar(pagoId: string, payload: ValidarPagoPayload) {
    setProcesando(pagoId);
    try {
      const data = await validarPago(pagoId, payload);
      setValidandoId(null);
      show('success', 'Pago validado', `Ticket ${data.ticket_id} — contenedor ${data.contenedor}`);
    } catch (e: any) {
      show('error', 'Error al validar', e.response?.data?.error || 'Error desconocido');
    } finally {
      setProcesando(null);
    }
  }

  async function onRechazar(pagoId: string) {
    const motivo = prompt('Motivo del rechazo (el comprobante no impactó):') || 'Comprobante no válido';
    setProcesando(pagoId);
    try {
      await rechazarPago(pagoId, motivo);
      show('info', 'Pago rechazado', motivo);
    } catch {
      show('error', 'Error al rechazar');
    } finally {
      setProcesando(null);
    }
  }

  /** No es un rechazo real: le pide al cliente que reenvíe el comprobante (ej. foto no legible). */
  async function onPedirDeNuevo(pagoId: string) {
    setProcesando(pagoId);
    try {
      await rechazarPago(pagoId, 'Comprobante no legible. Por favor, enviá una foto más clara.');
      show('info', 'Le pedimos al cliente que reenvíe el comprobante', 'Se le avisó por WhatsApp');
    } catch {
      show('error', 'No se pudo avisar al cliente');
    } finally {
      setProcesando(null);
    }
  }

  async function onConfirmarRetiro(numeroContenedor: string) {
    setProcesando(numeroContenedor);
    try {
      await confirmarRetiro(numeroContenedor);
      show('success', 'Llegada confirmada', `Contenedor ${numeroContenedor} — se avisó al chofer`);
    } catch (e: any) {
      show('error', 'No se pudo confirmar', e.response?.data?.error || 'Error desconocido');
    } finally {
      setProcesando(null);
    }
  }

  async function onEnviarFactura(pagoId: string) {
    const archivo = facturaFile[pagoId];
    if (!archivo) return;
    setProcesando(pagoId);
    try {
      await enviarFactura(pagoId, archivo);
      show('success', 'Factura enviada', 'Se mandó por WhatsApp al cliente');
      setFacturaFile((prev) => ({ ...prev, [pagoId]: undefined }));
    } catch (e: any) {
      show('error', 'No se pudo enviar la factura', e.response?.data?.error || 'Error desconocido');
    } finally {
      setProcesando(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>
          Bandeja de alertas
          <span className="live-badge">
            <span className="live-dot" />
            en vivo
          </span>
        </h2>
        <p>{alertas.length} alerta{alertas.length !== 1 ? 's' : ''} activa{alertas.length !== 1 ? 's' : ''}</p>
      </div>

      {alertas.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><CircleCheck strokeWidth={1.5} /></div>
            <div className="empty-state-title">Sin alertas activas</div>
            <div className="empty-state-text">El sistema está funcionando correctamente</div>
          </div>
        </div>
      ) : (
        <div className="space-y">
          {alertas.map((a) => {
            const esPago = a.tipo === 'pago_pendiente_validacion';
            const esRetiro = a.tipo === 'confirmar_retiro';
            const esFactura = a.tipo === 'factura_solicitada';
            const esAsesor = a.tipo === 'solicita_asesor';
            const expandida = esPago && validandoId === a.referencia_id;
            return (
              <div
                key={a.id}
                className={`alerta-card alerta-${a.tipo} ${esPago || esFactura || esAsesor ? 'alerta-card-pago' : ''}`}
              >
                <div className="alerta-card-top">
                  <div>
                    <div className="alerta-tipo">{tipoLabel[a.tipo] ?? a.tipo}</div>
                    <div className="alerta-msg">{a.mensaje}</div>
                    <div className="alerta-time">{new Date(a.creado_en).toLocaleString('es-UY')}</div>
                  </div>
                  {!esPago && !esRetiro && !esFactura && !esAsesor && (
                    <button onClick={() => resolver(a.id)} className="btn btn-ghost btn-sm">
                      <Check strokeWidth={2} /> Resolver
                    </button>
                  )}
                  {esRetiro && (
                    <RoleGate roles={['admin', 'operador']}>
                      <button
                        onClick={() => onConfirmarRetiro(a.referencia_id)}
                        className="btn btn-success btn-sm"
                        disabled={procesando === a.referencia_id}
                      >
                        {procesando === a.referencia_id ? '...' : <><Check strokeWidth={2} /> Confirmar llegada</>}
                      </button>
                    </RoleGate>
                  )}
                </div>

                {esFactura && (
                  <RoleGate roles={['admin', 'operador', 'finanzas']}>
                    <div className="alerta-pago-extra">
                      <input
                        type="file"
                        accept=".pdf,image/*"
                        onChange={(e) =>
                          setFacturaFile((prev) => ({ ...prev, [a.referencia_id]: e.target.files?.[0] }))
                        }
                      />
                      <button
                        onClick={() => onEnviarFactura(a.referencia_id)}
                        className="btn btn-success btn-sm"
                        disabled={procesando === a.referencia_id || !facturaFile[a.referencia_id]}
                      >
                        {procesando === a.referencia_id ? '...' : <><FileCheck strokeWidth={1.75} /> Enviar factura</>}
                      </button>
                    </div>
                  </RoleGate>
                )}

                {esAsesor && (
                  <RoleGate roles={['admin', 'operador']}>
                    <div className="alerta-pago-extra alerta-asesor-extra">
                      <ChatAsesor telefono={a.referencia_id} />
                      <button onClick={() => resolver(a.id)} className="btn btn-success btn-sm">
                        <Check strokeWidth={2} /> Conversación resuelta — el bot vuelve a responder
                      </button>
                    </div>
                  </RoleGate>
                )}

                {esPago && (
                  <div className="alerta-pago-extra">
                    <div className="alerta-pago-info">
                      <div className="pago-phone">{a.cliente_telefono}</div>
                      <div className="pago-detail">
                        {a.zona ?? 'Sin zona'} ·{' '}
                        {a.precio ? `${a.moneda ?? ''} ${Number(a.precio).toLocaleString('es-AR')}`.trim() : 'Sin monto'}
                      </div>
                      <RoleGate roles={['admin', 'finanzas']}>
                        {a.tiene_comprobante ? (
                          <ComprobanteViewer pagoId={a.referencia_id} />
                        ) : (
                          <span className="text-muted">Sin comprobante adjunto</span>
                        )}
                      </RoleGate>
                    </div>

                    <RoleGate roles={['admin', 'operador', 'finanzas']}>
                      {!expandida && (
                        <div className="alerta-pago-actions">
                          <button
                            onClick={() => setValidandoId(a.referencia_id)}
                            className="btn btn-success btn-sm"
                            disabled={procesando === a.referencia_id}
                          >
                            <Check strokeWidth={2} /> Impactó — Validar
                          </button>
                          <button
                            onClick={() => onRechazar(a.referencia_id)}
                            className="btn btn-danger btn-sm"
                            disabled={procesando === a.referencia_id}
                          >
                            <X strokeWidth={2} /> No impactó — Rechazar
                          </button>
                          <button
                            onClick={() => onPedirDeNuevo(a.referencia_id)}
                            className="btn btn-ghost btn-sm"
                            disabled={procesando === a.referencia_id}
                            title="El comprobante no se lee bien: le pedimos al cliente que lo reenvíe"
                          >
                            <RotateCcw strokeWidth={1.75} /> Pedir de nuevo
                          </button>
                        </div>
                      )}
                    </RoleGate>
                  </div>
                )}

                {expandida && (
                  <ValidarPagoForm
                    choferes={choferes}
                    procesando={procesando === a.referencia_id}
                    onConfirm={(payload) => onValidar(a.referencia_id, payload)}
                    onCancel={() => setValidandoId(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
