import { useState } from 'react';
import { Check, X, RotateCcw, CircleCheck, FileCheck } from 'lucide-react';
import { useAlertas } from '../hooks/useAlertas';
import { RoleGate } from '../components/RoleGate';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { useToast } from '../components/Toast';
import { tipoLabel } from '../lib/alertLabels';

export function Alertas() {
  const { alertas: todasLasAlertas, resolver, validarPago, rechazarPago, confirmarRetiro, enviarFactura } = useAlertas();
  // Los pedidos de asesor tienen su propia sección ("Pide Asesoría"), acá no se muestran.
  const alertas = todasLasAlertas.filter((a) => a.tipo !== 'solicita_asesor');
  const { show } = useToast();
  const [procesando, setProcesando] = useState<string | null>(null);
  const [facturaFile, setFacturaFile] = useState<Record<string, File | undefined>>({});

  // La logística (chofer, contenedor) se arma un día antes desde la
  // pestaña Viajes — acá solo se confirma el pago, y de ahí se manda directo.
  async function onValidar(pagoId: string) {
    setProcesando(pagoId);
    try {
      const data = await validarPago(pagoId, {});
      show(
        'success',
        'Pago validado',
        data.reservado_ahora
          ? `Ticket ${data.ticket_id} — contenedor ${data.contenedor}`
          : `Ticket ${data.ticket_id} — contenedor ${data.contenedor} reservado a futuro, todavía está ocupado`,
      );
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
            const esPago = a.tipo === 'pago_pendiente_validacion' || a.tipo === 'cuenta_corriente_solicitada';
            const esRetiro = a.tipo === 'confirmar_retiro';
            const esFactura = a.tipo === 'factura_solicitada';
            return (
              <div
                key={a.id}
                className={`alerta-card alerta-${a.tipo} ${esPago || esFactura ? 'alerta-card-pago' : ''}`}
              >
                <div className="alerta-card-top">
                  <div>
                    <div className="alerta-tipo">{tipoLabel[a.tipo] ?? a.tipo}</div>
                    <div className="alerta-msg">{a.mensaje}</div>
                    <div className="alerta-time">{new Date(a.creado_en).toLocaleString('es-UY')}</div>
                  </div>
                  {!esPago && !esRetiro && !esFactura && (
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
                        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
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
                        ) : a.tipo === 'cuenta_corriente_solicitada' ? (
                          <span className="text-muted">📋 Pago a cuenta corriente — sin comprobante</span>
                        ) : (
                          <span className="text-muted">Sin comprobante adjunto</span>
                        )}
                      </RoleGate>
                    </div>

                    <RoleGate roles={['admin', 'operador', 'finanzas']}>
                      <div className="alerta-pago-actions">
                        <button
                          onClick={() => onValidar(a.referencia_id)}
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
                    </RoleGate>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
