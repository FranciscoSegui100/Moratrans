import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Layers,
  CreditCard,
  Package,
  Clock,
  MessageCircle,
  Truck,
  AlertTriangle,
  Search,
  Check,
  X,
  RotateCcw,
  CircleCheck,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Receipt,
  HardHat,
  SlidersHorizontal,
  LayoutGrid,
} from 'lucide-react';
import { useAlertas, Alerta } from '../hooks/useAlertas';
import { RoleGate } from '../components/RoleGate';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { useToast } from '../components/Toast';
import {
  tipoLabel,
  tipoDescripcion,
  SECTORES,
  SectorId,
  getSectorDeTipo,
} from '../lib/alertLabels';
import { formatearFechaHora } from '../lib/fechas';

/** Retorna el ícono más representativo para cada tipo de alerta. */
function iconoDeTipo(tipo: string) {
  switch (tipo) {
    case 'pago_pendiente_validacion':
    case 'cuenta_corriente_solicitada':
      return <CreditCard size={18} strokeWidth={2} style={{ color: 'var(--accent)' }} />;
    case 'pago_vencido':
    case 'factura_solicitada':
      return <Receipt size={18} strokeWidth={2} style={{ color: 'var(--danger)' }} />;
    case 'alargue_solicitado':
    case 'contenedor_por_vencer':
      return <Clock size={18} strokeWidth={2} style={{ color: 'var(--warning)' }} />;
    case 'confirmar_retiro':
    case 'retiro_solicitado':
    case 'recambio_solicitado':
    case 'entrega_solicitada':
      return <Package size={18} strokeWidth={2} style={{ color: 'var(--warning)' }} />;
    case 'stock_bajo':
    case 'envio_fallido':
      return <AlertTriangle size={18} strokeWidth={2} style={{ color: 'var(--danger)' }} />;
    case 'solicita_asesor':
      return <MessageCircle size={18} strokeWidth={2} style={{ color: 'var(--purple)' }} />;
    case 'chofer_no_reconocido':
    case 'chofer_cambio_telefono':
      return <HardHat size={18} strokeWidth={2} style={{ color: 'var(--info)' }} />;
    default:
      return <AlertTriangle size={18} strokeWidth={2} style={{ color: 'var(--text-muted)' }} />;
  }
}

/** Retorna el ícono para las pestañas de sector principal. */
function iconoDeSector(id: SectorId) {
  switch (id) {
    case 'todos':
      return <Layers size={16} strokeWidth={2} />;
    case 'pagos':
      return <CreditCard size={16} strokeWidth={2} />;
    case 'logistica':
      return <Package size={16} strokeWidth={2} />;
    case 'asesor':
      return <MessageCircle size={16} strokeWidth={2} />;
    case 'choferes':
      return <Truck size={16} strokeWidth={2} />;
    case 'sistema':
      return <AlertTriangle size={16} strokeWidth={2} />;
  }
}

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

  // Estados de sectorización y filtrado
  const [sectorActivo, setSectorActivo] = useState<SectorId>('todos');
  const [tipoActivo, setTipoActivo] = useState<string>('todos');
  const [busqueda, setBusqueda] = useState('');
  const [modoAgrupado, setModoAgrupado] = useState(true);
  const [colapsados, setColapsados] = useState<Record<string, boolean>>({});

  // Conteo de alertas por sector en tiempo real
  const conteoPorSector = useMemo(() => {
    const counts: Record<SectorId, number> = {
      todos: alertas.length,
      pagos: 0,
      logistica: 0,
      asesor: 0,
      choferes: 0,
      sistema: 0,
    };
    alertas.forEach((a) => {
      const sec = getSectorDeTipo(a.tipo);
      counts[sec.id] = (counts[sec.id] ?? 0) + 1;
    });
    return counts;
  }, [alertas]);

  // Alertas filtradas según sector, tipo y búsqueda
  const alertasFiltradas = useMemo(() => {
    return alertas.filter((a) => {
      // Filtro por sector
      if (sectorActivo !== 'todos') {
        const sec = getSectorDeTipo(a.tipo);
        if (sec.id !== sectorActivo) return false;
      }

      // Filtro por tipo específico
      if (tipoActivo !== 'todos' && a.tipo !== tipoActivo) {
        return false;
      }

      // Filtro por búsqueda de texto
      if (busqueda.trim()) {
        const q = busqueda.toLowerCase().trim();
        const coincideMensaje = a.mensaje.toLowerCase().includes(q);
        const coincideTelefono = a.cliente_telefono ? a.cliente_telefono.includes(q) : false;
        const coincideRef = a.referencia_id ? a.referencia_id.toLowerCase().includes(q) : false;
        const coincideZona = a.zona ? a.zona.toLowerCase().includes(q) : false;
        const coincideTipo = (tipoLabel[a.tipo] ?? a.tipo).toLowerCase().includes(q);
        return coincideMensaje || coincideTelefono || coincideRef || coincideZona || coincideTipo;
      }

      return true;
    });
  }, [alertas, sectorActivo, tipoActivo, busqueda]);

  // Tipos de alerta disponibles en el sector actual (para píldoras de subfiltro)
  const tiposEnSector = useMemo(() => {
    const pool = sectorActivo === 'todos'
      ? alertas
      : alertas.filter((a) => getSectorDeTipo(a.tipo).id === sectorActivo);

    const counts: Record<string, number> = {};
    pool.forEach((a) => {
      counts[a.tipo] = (counts[a.tipo] ?? 0) + 1;
    });
    return counts;
  }, [alertas, sectorActivo]);

  // Alertas agrupadas por tipo (cuando modoAgrupado está activo)
  const alertasPorTipo = useMemo(() => {
    const mapa = new Map<string, Alerta[]>();
    alertasFiltradas.forEach((a) => {
      const arr = mapa.get(a.tipo) ?? [];
      arr.push(a);
      mapa.set(a.tipo, arr);
    });
    return Array.from(mapa.entries());
  }, [alertasFiltradas]);

  function toggleColapso(tipo: string) {
    setColapsados((prev) => ({ ...prev, [tipo]: !prev[tipo] }));
  }

  function colapsarTodos() {
    const nuevo: Record<string, boolean> = {};
    alertasPorTipo.forEach(([tipo]) => {
      nuevo[tipo] = true;
    });
    setColapsados(nuevo);
  }

  function expandirTodos() {
    setColapsados({});
  }

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

  // Renderizador unificado de una tarjeta de alerta individual
  function renderAlertaCard(a: Alerta) {
    const esPago = a.tipo === 'pago_pendiente_validacion' || a.tipo === 'cuenta_corriente_solicitada';
    const esRetiro = a.tipo === 'confirmar_retiro';
    const sector = getSectorDeTipo(a.tipo);

    return (
      <div
        key={a.id}
        className={`alerta-card alerta-${a.tipo} ${esPago ? 'alerta-card-pago' : ''}`}
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
      {/* Encabezado Principal */}
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <h2>
              Bandeja de alertas
              <span className="live-badge">
                <span className="live-dot" />
                en vivo
              </span>
            </h2>
            <p>
              {alertas.length} alerta{alertas.length !== 1 ? 's' : ''} activa{alertas.length !== 1 ? 's' : ''} organizadas por sector operativo
            </p>
          </div>

          {/* Selector de Modo de Vista */}
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className={`btn btn-sm ${modoAgrupado ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setModoAgrupado(true)}
              title="Organizar alertas en sectores por tipo de alerta"
            >
              <LayoutGrid size={14} /> Sectorizado por tipo
            </button>
            <button
              className={`btn btn-sm ${!modoAgrupado ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setModoAgrupado(false)}
              title="Ver todas en lista cronológica continua"
            >
              <SlidersHorizontal size={14} /> Lista cronológica
            </button>
          </div>
        </div>
      </div>

      {/* 1) Barra de Sectores Principales (Tabs) */}
      <div className="alerta-sector-nav">
        {SECTORES.map((s) => {
          const count = conteoPorSector[s.id] ?? 0;
          const isActive = sectorActivo === s.id;
          return (
            <button
              key={s.id}
              className={`alerta-sector-tab ${isActive ? 'active' : ''}`}
              onClick={() => {
                setSectorActivo(s.id);
                setTipoActivo('todos'); // Resetea el filtro específico al cambiar de sector
              }}
            >
              {iconoDeSector(s.id)}
              <span>{s.label}</span>
              <span className="alerta-sector-count">{count}</span>
            </button>
          );
        })}
      </div>

      {/* 2) Barra de Herramientas: Buscador y Subfiltros por Tipo Específico */}
      <div className="alerta-toolbar">
        {/* Buscador reactivo */}
        <div className="alerta-search">
          <Search size={15} className="alerta-search-icon" />
          <input
            className="form-input"
            placeholder="🔍 Buscar por teléfono, mensaje, zona..."
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />
        </div>

        {/* Acciones de colapso rápido en modo agrupado */}
        {modoAgrupado && alertasPorTipo.length > 1 && (
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={expandirTodos} className="btn btn-ghost btn-sm" style={{ fontSize: '0.78rem' }}>
              Expandir todos
            </button>
            <button onClick={colapsarTodos} className="btn btn-ghost btn-sm" style={{ fontSize: '0.78rem' }}>
              Colapsar todos
            </button>
          </div>
        )}
      </div>

      {/* 3) Píldoras de Tipo Específico de Alerta */}
      {Object.keys(tiposEnSector).length > 1 && (
        <div className="alerta-pills-row">
          <span className="text-muted" style={{ fontSize: '0.75rem', fontWeight: 600, marginRight: '4px' }}>
            Filtrar por tipo:
          </span>
          <button
            className={`alerta-pill ${tipoActivo === 'todos' ? 'active' : ''}`}
            onClick={() => setTipoActivo('todos')}
          >
            Todos los tipos ({Object.values(tiposEnSector).reduce((a, b) => a + b, 0)})
          </button>
          {Object.entries(tiposEnSector).map(([tipo, count]) => (
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

      {/* 4) Contenido Principal: Sectorizado o Cronológico */}
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
            <div className="empty-state-title">Sin alertas en este filtro</div>
            <div className="empty-state-text">
              No hay alertas que coincidan con el sector o búsqueda seleccionada.
            </div>
            <button
              onClick={() => {
                setSectorActivo('todos');
                setTipoActivo('todos');
                setBusqueda('');
              }}
              className="btn btn-ghost btn-sm"
              style={{ marginTop: '10px' }}
            >
              Restablecer filtros
            </button>
          </div>
        </div>
      ) : modoAgrupado ? (
        /* VISTA SECTORIZADA AGRUPADA POR TIPO DE ALERTA */
        <div className="space-y">
          {alertasPorTipo.map(([tipo, items]) => {
            const estaColapsado = !!colapsados[tipo];
            const sector = getSectorDeTipo(tipo);

            return (
              <div key={tipo} className="alerta-grupo-card">
                {/* Header del Sector de Tipo de Alerta */}
                <div className="alerta-grupo-header" onClick={() => toggleColapso(tipo)}>
                  <div className="alerta-grupo-title-box">
                    <div className="alerta-grupo-icon">{iconoDeTipo(tipo)}</div>
                    <div>
                      <div className="alerta-grupo-title">
                        {tipoLabel[tipo] ?? tipo}
                        <span className="badge badge-accent" style={{ fontSize: '0.72rem', padding: '2px 8px' }}>
                          {items.length}
                        </span>
                        <span className="alerta-sector-tag">{sector.label}</span>
                      </div>
                      <div className="alerta-grupo-desc">
                        {tipoDescripcion[tipo] ?? 'Alertas operativas de este tipo'}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="text-muted" style={{ fontSize: '0.76rem' }}>
                      {estaColapsado ? 'Expandir' : 'Colapsar'}
                    </span>
                    {estaColapsado ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                  </div>
                </div>

                {/* Tarjetas de Alertas de este Tipo */}
                {!estaColapsado && (
                  <div className="alerta-grupo-body">
                    {items.map(renderAlertaCard)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* VISTA CRONOLÓGICA PLANA */
        <div className="space-y">
          {alertasFiltradas.map(renderAlertaCard)}
        </div>
      )}
    </div>
  );
}
