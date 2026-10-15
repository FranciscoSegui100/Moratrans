import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Check, X, RotateCcw, CircleCheck, ArrowRight } from 'lucide-react';
import { useAlertas, Alerta } from '../hooks/useAlertas';
import { RoleGate } from '../components/RoleGate';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { useToast } from '../components/Toast';
import { tipoLabel, getSectorDeTipo } from '../lib/alertLabels';
import { formatearFechaHora } from '../lib/fechas';

/** Destino operativo según el tipo de alerta. */
function rutaAlerta(a: Alerta): { to: string; label: string } | null {
  switch (a.tipo) {
    case 'contenedor_por_vencer':
    case 'stock_bajo':
      return { to: '/contenedores', label: 'Ir a Contenedores' };
    case 'pago_vencido':
    case 'alargue_solicitado':
      return { to: '/pagos', label: 'Ir a Validar pagos' };
    case 'solicita_asesor':
    case 'factura_solicitada':
      return { to: `/conversaciones?tel=${encodeURIComponent(a.referencia_id)}`, label: 'Ir a Conversaciones' };
    case 'recambio_solicitado':
    case 'retiro_solicitado':
    case 'entrega_solicitada':
      return { to: '/viajes', label: 'Ir a Viajes' };
    case 'chofer_no_reconocido':
    case 'chofer_cambio_telefono':
      return { to: '/choferes', label: 'Ir a Choferes' };
    default:
      return null;
  }
}

export function Alertas() {
  const { alertas, resolver, validarPago, rechazarPago, confirmarRetiro } = useAlertas();
  const { show } = useToast();
  const [procesando, setProcesando] = useState<string | null>(null);

  // Esta pantalla es, antes que nada, una lista de atajos para ir a resolver
  // algo en otro lado — un solo filtro por tipo (con contador) alcanza para
  // encontrar lo que se busca sin agregar capas (sectores, modos de vista,
  // grupos colapsables, buscador) que solo suman clicks para lo que termina
  // siendo "ver qué hay pendiente y apretar el botón".
  const [tipoActivo, setTipoActivo] = useState<string>('todos');

  const conteoPorTipo = useMemo(() => {
    const counts: Record<string, number> = {};
    alertas.forEach((a) => {
      counts[a.tipo] = (counts[a.tipo] ?? 0) + 1;
    });
    // Más alertas primero: lo que más junta es, en general, lo que más conviene mirar.
    return Object.entries(counts).sort(([, a], [, b]) => b - a);
  }, [alertas]);

  const alertasFiltradas = useMemo(() => {
    if (tipoActivo === 'todos') return alertas;
    return alertas.filter((a) => a.tipo === tipoActivo);
  }, [alertas, tipoActivo]);

  // Acciones sobre alertas de pagos
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

  async function onResolver(id: string) {
    setProcesando(id);
    try {
      await resolver(id);
    } catch (e: any) {
      show('error', 'No se pudo resolver la alerta', e.response?.data?.error || 'Error desconocido');
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

  function renderAlertaCard(a: Alerta) {
    const esPago = a.tipo === 'pago_pendiente_validacion' || a.tipo === 'cuenta_corriente_solicitada';
    const esRetiro = a.tipo === 'confirmar_retiro';
    const sector = getSectorDeTipo(a.tipo);
    // Mismo tipo de alerta para "por vencer" y "ya venció" (ver
    // alertas.cron.ts) — distinguimos acá por el texto para que lo ya
    // vencido se note en rojo en vez de confundirse con el naranja de
    // "todavía falta".
    const yaVencio = a.tipo === 'contenedor_por_vencer' && a.mensaje.includes('YA VENCIÓ');

    return (
      <div
        key={a.id}
        className={`alerta-card alerta-${a.tipo} ${esPago ? 'alerta-card-pago' : ''} ${yaVencio ? 'alerta-vencida' : ''}`}
      >
        <div className="alerta-card-top">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <span className="alerta-tipo">{tipoLabel[a.tipo] ?? a.tipo}</span>
              <span className="alerta-sector-tag">{sector.label}</span>
            </div>
            <div className="alerta-msg">{a.mensaje}</div>
            <div className="alerta-time">{formatearFechaHora(a.creado_en)}</div>
          </div>

          {!esPago && !esRetiro && (
            <RoleGate roles={['admin', 'operador', 'finanzas']}>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                {rutaAlerta(a) && (
                  <Link to={rutaAlerta(a)!.to} className="btn btn-primary btn-sm">
                    {rutaAlerta(a)!.label} <ArrowRight size={13} strokeWidth={1.75} />
                  </Link>
                )}
                <button
                  onClick={() => onResolver(a.id)}
                  className="btn btn-ghost btn-sm"
                  disabled={procesando === a.id}
                  title="Marcar alerta como resuelta"
                >
                  <Check strokeWidth={2} /> Resolver
                </button>
              </div>
            </RoleGate>
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

        {esPago && (
          <div className="alerta-pago-extra">
            <div className="alerta-pago-info">
              <div className="pago-phone">{a.cliente_telefono}</div>
              <div className="pago-detail">
                {a.zona ?? 'Sin zona'} ·{' '}
                {a.precio ? `ARS ${Number(a.precio).toLocaleString('es-AR')}` : 'Sin monto'}
              </div>
              <RoleGate roles={['admin', 'operador', 'finanzas']}>
                {a.tiene_comprobante ? (
                  <ComprobanteViewer pagoId={a.referencia_id} />
                ) : a.medio_pago === 'efectivo' ? (
                  <span className="text-muted">💵 Paga en efectivo — sin comprobante</span>
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
                  <Check strokeWidth={2} /> {a.medio_pago === 'efectivo' ? 'Confirmar pedido' : 'Impactó — Validar'}
                </button>
                <button
                  onClick={() => onRechazar(a.referencia_id)}
                  className="btn btn-danger btn-sm"
                  disabled={procesando === a.referencia_id}
                >
                  <X strokeWidth={2} /> {a.medio_pago === 'efectivo' ? 'Rechazar pedido' : 'No impactó — Rechazar'}
                </button>
                {a.medio_pago !== 'efectivo' && (
                  <button
                    onClick={() => onPedirDeNuevo(a.referencia_id)}
                    className="btn btn-ghost btn-sm"
                    disabled={procesando === a.referencia_id}
                    title="El comprobante no se lee bien: le pedimos al cliente que lo reenvíe"
                  >
                    <RotateCcw strokeWidth={1.75} /> Pedir de nuevo
                  </button>
                )}
              </div>
            </RoleGate>
          </div>
        )}
      </div>
    );
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

      {conteoPorTipo.length > 1 && (
        <div className="alerta-pills-row">
          <button
            className={`alerta-pill ${tipoActivo === 'todos' ? 'active' : ''}`}
            onClick={() => setTipoActivo('todos')}
          >
            Todas ({alertas.length})
          </button>
          {conteoPorTipo.map(([tipo, count]) => (
            <button
              key={tipo}
              className={`alerta-pill ${tipoActivo === tipo ? 'active' : ''}`}
              onClick={() => setTipoActivo(tipoActivo === tipo ? 'todos' : tipo)}
            >
              {tipoLabel[tipo] ?? tipo} ({count})
            </button>
          ))}
        </div>
      )}

      {alertas.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><CircleCheck strokeWidth={1.5} /></div>
            <div className="empty-state-title">Sin alertas activas</div>
            <div className="empty-state-text">El sistema y la flota están funcionando correctamente</div>
          </div>
        </div>
      ) : alertasFiltradas.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><CircleCheck strokeWidth={1.5} /></div>
            <div className="empty-state-title">Sin alertas de este tipo</div>
            <button onClick={() => setTipoActivo('todos')} className="btn btn-ghost btn-sm" style={{ marginTop: '10px' }}>
              Ver todas
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y">
          {alertasFiltradas.map(renderAlertaCard)}
        </div>
      )}
    </div>
  );
}
