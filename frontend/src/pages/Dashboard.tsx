import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Package, CircleCheck, CircleDollarSign, Truck, CreditCard, Users, Power, TriangleAlert,
  Wallet, Bell, type LucideIcon,
} from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

// Cuenta desde el valor anterior hasta el nuevo con ease-out: le da a los
// KPIs un golpe de vida cada vez que cargan o cambian, en vez de aparecer
// como texto estático.
function useCountUp(target: number | null, duration = 700) {
  const [value, setValue] = useState(0);
  const prevTarget = useRef(0);
  useEffect(() => {
    if (target === null) return;
    const from = prevTarget.current;
    prevTarget.current = target;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

interface Kpis {
  contenedores_activos: number;
  contenedores_reservados: number;
  contenedores_disponibles: number;
  cobros_pendientes: number;
  cobros_pendientes_monto: string;
  cobros_vencidos: number;
  viajes_hoy: number;
  viajes_ayer: number;
  entregas_hoy: number;
  alertas_activas: number;
  deuda_total: string;
  clientes_con_deuda: number;
}

interface TendenciaDia {
  fecha: string;
  viajes: number;
  entregas: number;
}

interface EstadoDist {
  estado: string;
  total: number;
}

interface EstadoBot {
  bot_activo: boolean;
  actualizado_en: string;
}

interface ActividadItem {
  tipo: 'contenedor' | 'pago';
  entidad_id: string | null;
  accion: string;
  actor: string;
  cliente_telefono: string | null;
  fecha: string;
  detalle: string | null;
}

const estadoColors: Record<string, string> = {
  disponible:     'var(--success)',
  reservado:      'var(--accent)',
  entregado:      'var(--purple)',
  retirado:       'var(--neutral)',
  mantenimiento:  'var(--danger)',
};

// Orden fijo (no alfabético) para que la leyenda y la dona sigan el flujo
// natural del contenedor: disponible -> reservado -> con el cliente -> volviendo.
const estadoOrden = ['disponible', 'reservado', 'entregado', 'retirado', 'mantenimiento'];
const estadoLabels: Record<string, string> = {
  disponible:    'Disponible',
  reservado:     'Reservado',
  entregado:     'Con el cliente',
  retirado:      'Volviendo al depósito',
  mantenimiento: 'En mantenimiento',
};

const accionContenedorLabels: Record<string, string> = {
  disponible:    'liberó',
  reservado:     'reservó',
  entregado:     'entregó',
  retirado:      'retiró',
  mantenimiento: 'puso en mantenimiento',
};
const accionPagoLabels: Record<string, string> = {
  pendiente: 'envió un comprobante',
  validado:  'tiene un pago validado',
  rechazado: 'tiene un pago rechazado',
};

function KpiCard({
  icon: Icon, tint, fg, label, value, formato = 'entero', trend, caption, sparkline,
}: {
  icon: LucideIcon; tint: string; fg: string; label: string;
  value: number | null; formato?: 'entero' | 'dinero';
  trend?: { texto: string; tono: 'positivo' | 'negativo' | 'neutro' };
  caption?: ReactNode;
  sparkline?: number[];
}) {
  const shown = useCountUp(value);
  const trendColor = trend?.tono === 'positivo' ? 'var(--success)' : trend?.tono === 'negativo' ? 'var(--danger)' : 'var(--text-secondary)';
  const maxSpark = sparkline && sparkline.length > 0 ? Math.max(1, ...sparkline) : 1;

  return (
    <div className="kpi-card">
      <div className="kpi-header">
        <div className="kpi-icon" style={{ background: tint, color: fg }}><Icon strokeWidth={1.75} /></div>
        {trend && <div className="kpi-trend" style={{ color: trendColor }}>{trend.texto}</div>}
      </div>
      <div className="kpi-value">
        {value === null ? '—' : formato === 'dinero' ? `$${shown.toLocaleString('es-AR')}` : shown}
      </div>
      <div className="kpi-label">{label}</div>
      {caption && <div className="kpi-caption">{caption}</div>}
      {sparkline && sparkline.length > 0 && (
        <div className="kpi-sparkline">
          {sparkline.map((v, i) => (
            <div key={i} className="spark-bar" style={{ height: `${Math.round((v / maxSpark) * 100)}%`, background: tint }} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const { data: kpis = null, isError: kpisError, refetch: refetchKpis } = useQuery({
    queryKey: ['dashboard', 'kpis'],
    queryFn: () => api.get<Kpis>('/api/dashboard/kpis').then((r) => r.data),
  });
  const { data: tendencia = [] } = useQuery({
    queryKey: ['dashboard', 'tendencia'],
    queryFn: () => api.get<TendenciaDia[]>('/api/dashboard/tendencia').then((r) => r.data),
  });
  const { data: distribucion = [], isError: distribucionError, refetch: refetchDistribucion } = useQuery({
    queryKey: ['dashboard', 'contenedores'],
    queryFn: () => api.get<EstadoDist[]>('/api/dashboard/contenedores').then((r) => r.data),
  });
  const { data: actividad = [] } = useQuery({
    queryKey: ['dashboard', 'actividad'],
    queryFn: () => api.get<ActividadItem[]>('/api/dashboard/actividad').then((r) => r.data),
  });
  const hayError = kpisError || distribucionError;
  const { data: estadoBot } = useQuery({
    queryKey: ['config', 'bot'],
    queryFn: () => api.get<EstadoBot>('/api/config/bot').then((r) => r.data),
  });

  const totalContenedores = distribucion.reduce((s, d) => s + d.total, 0);

  // Segmentos reales de la dona: orden fijo, arrancan donde termina el
  // anterior (dashoffset acumulado negativo) — nada hardcodeado.
  let acumuladoPct = 0;
  const segmentosDona = estadoOrden
    .map((estado) => distribucion.find((d) => d.estado === estado))
    .filter((d): d is EstadoDist => !!d && d.total > 0)
    .map((d) => {
      const pct = totalContenedores > 0 ? (d.total / totalContenedores) * 100 : 0;
      const offset = -acumuladoPct;
      acumuladoPct += pct;
      return { estado: d.estado, pct, offset };
    });

  const viajesTrend = tendencia.map((d) => d.viajes);
  const entregasTrend = tendencia.map((d) => d.entregas);
  const diffViajes = kpis ? kpis.viajes_hoy - kpis.viajes_ayer : 0;

  async function toggleBot() {
    const activarlo = estadoBot?.bot_activo === false;
    const aviso = activarlo
      ? '¿Reactivar el bot? Los clientes van a volver a recibir respuestas automáticas.'
      : '¿Desactivar el bot? Mientras esté apagado, TODOS los clientes van a recibir el mensaje de fuera de horario en vez de la respuesta automática habitual. Los choferes no se ven afectados.';
    if (!confirm(aviso)) return;
    try {
      const { data } = await api.patch<EstadoBot>('/api/config/bot', { bot_activo: activarlo });
      queryClient.setQueryData(['config', 'bot'], data);
      show('success', activarlo ? 'Bot reactivado' : 'Bot desactivado', activarlo ? undefined : 'Los clientes ahora reciben el mensaje de fuera de horario.');
    } catch (err: any) {
      show('error', 'No se pudo cambiar el estado del bot', err.response?.data?.error || 'Error desconocido');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Dashboard</h2>
          <p>Resumen general del sistema logístico</p>
        </div>
        <RoleGate roles={['admin', 'operador']}>
          <button
            className={`btn btn-sm ${estadoBot?.bot_activo === false ? 'btn-success' : 'btn-danger'}`}
            onClick={toggleBot}
          >
            <Power size={16} strokeWidth={2} />
            {estadoBot?.bot_activo === false ? 'Activar bot' : 'Desactivar bot'}
          </button>
        </RoleGate>
      </div>

      {hayError && (
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
            background: 'var(--danger-bg)', border: '1px solid var(--danger)', borderRadius: 'var(--radius)',
            padding: '10px 14px', marginBottom: '16px', fontSize: '0.85rem', color: 'var(--danger)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <TriangleAlert size={18} strokeWidth={2} />
            No se pudieron cargar los datos del dashboard. Puede ser un problema de conexión.
          </div>
          <button className="btn btn-sm" onClick={() => { refetchKpis(); refetchDistribucion(); }}>
            Reintentar
          </button>
        </div>
      )}

      {estadoBot?.bot_activo === false && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            background: 'var(--warning-bg)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)',
            padding: '10px 14px', marginBottom: '16px', fontSize: '0.85rem', color: 'var(--warning)',
          }}
        >
          <TriangleAlert size={18} strokeWidth={2} />
          El bot está <strong>desactivado</strong>: los clientes reciben el mensaje de fuera de horario en vez de respuestas automáticas.
        </div>
      )}

      {/* KPI Cards — todo sale de datos reales, sin números ni gráficas de ejemplo. */}
      <div className="kpi-grid">
        <KpiCard
          icon={Package} tint="var(--accent-tint)" fg="var(--accent-dark)"
          label="Contenedores con el cliente" value={kpis ? kpis.contenedores_activos : null}
          caption={kpis ? `${kpis.entregas_hoy} entregados hoy` : undefined}
          sparkline={entregasTrend}
        />
        <KpiCard
          icon={CircleCheck} tint="var(--success-bg)" fg="var(--success)"
          label="Disponibles" value={kpis ? kpis.contenedores_disponibles : null}
          caption={kpis ? `${kpis.contenedores_reservados} reservados` : undefined}
        />
        <KpiCard
          icon={Truck} tint="var(--purple-bg)" fg="var(--purple)"
          label="Viajes de hoy" value={kpis ? kpis.viajes_hoy : null}
          trend={kpis ? {
            texto: diffViajes === 0 ? '= que ayer' : `${diffViajes > 0 ? '▲' : '▼'} ${Math.abs(diffViajes)} vs ayer`,
            tono: 'neutro',
          } : undefined}
          sparkline={viajesTrend}
        />
        <KpiCard
          icon={CircleDollarSign} tint="var(--warning-bg)" fg="var(--warning)"
          label="Cobros pendientes" value={kpis ? kpis.cobros_pendientes : null}
          caption={kpis ? (
            <>
              <span>${Number(kpis.cobros_pendientes_monto).toLocaleString('es-AR')} adeudado</span>
              {kpis.cobros_vencidos > 0 && <span style={{ color: 'var(--danger)' }}>· {kpis.cobros_vencidos} vencidos (+24h)</span>}
            </>
          ) : undefined}
        />
        <KpiCard
          icon={Wallet} tint="var(--neutral-bg)" fg="var(--neutral)"
          label="Deuda de clientes" value={kpis ? Number(kpis.deuda_total) : null} formato="dinero"
          caption={kpis ? (
            <>
              <span>{kpis.clientes_con_deuda} cliente{kpis.clientes_con_deuda !== 1 ? 's' : ''} con saldo pendiente</span>
              <Link to="/clientes" style={{ fontWeight: 600 }}>Ver →</Link>
            </>
          ) : undefined}
        />
        <KpiCard
          icon={TriangleAlert} tint="var(--danger-bg)" fg="var(--danger)"
          label="Alertas activas" value={kpis ? kpis.alertas_activas : null}
          caption={<Link to="/alertas" style={{ fontWeight: 600 }}>Ver bandeja →</Link>}
        />
      </div>

      {/* Distribución de contenedores */}
      <div className="chart-grid">
        <div className="card">
          <div className="section-title">Distribución de contenedores por estado</div>
          <div style={{ display: 'flex', gap: '20px', alignItems: 'center', marginTop: '16px' }}>
            <div className="donut-chart">
               <div className="donut-center">
                 <div className="donut-value">{totalContenedores}</div>
                 <div className="donut-label">totales</div>
               </div>
               <svg viewBox="0 0 36 36" className="circular-chart">
                 <path className="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--bg-surface)" strokeWidth="4" />
                 {segmentosDona.map((s) => (
                   <path
                     key={s.estado}
                     strokeDasharray={`${s.pct}, 100`}
                     strokeDashoffset={s.offset}
                     d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                     fill="none"
                     stroke={estadoColors[s.estado] || 'var(--accent)'}
                     strokeWidth="4"
                   />
                 ))}
               </svg>
            </div>

            <div style={{ flex: 1 }}>
              {distribucion.length === 0 ? (
                <div className="empty-state-text">No hay contenedores cargados</div>
              ) : (
                estadoOrden
                  .map((estado) => distribucion.find((d) => d.estado === estado))
                  .filter((d): d is EstadoDist => !!d)
                  .map((d) => (
                    <div key={d.estado} className="estado-bar">
                      <div className="estado-name">
                        <span className="badge-dot" style={{ background: estadoColors[d.estado] || 'var(--accent)' }} />
                        {estadoLabels[d.estado] ?? d.estado}
                      </div>
                      <div className="bar-track">
                        <div
                          className="bar-fill"
                          style={{
                            width: `${totalContenedores > 0 ? Math.round((d.total / totalContenedores) * 100) : 0}%`,
                            background: estadoColors[d.estado] || 'var(--accent)',
                          }}
                        />
                      </div>
                      <div className="estado-count">{d.total}</div>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section-title">Accesos rápidos</div>
          <div className="space-y">
            {[
              { href: '/pagos',       icon: CreditCard, label: 'Validar pagos pendientes', badge: kpis?.cobros_pendientes },
              { href: '/alertas',     icon: Bell,       label: 'Bandeja de alertas',        badge: kpis?.alertas_activas },
              { href: '/viajes',      icon: Truck,      label: 'Viajes y rutas del día' },
              { href: '/clientes',    icon: Users,      label: 'Clientes' },
              { href: '/contenedores',icon: Package,    label: 'Contenedores' },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} to={item.href} className="quick-access-btn">
                  <div className="quick-access-icon"><Icon size={16} strokeWidth={1.75} /></div>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {!!item.badge && (
                    <span className="badge rechazado" style={{ fontSize: '0.7rem' }}>{item.badge}</span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: '16px' }}>
         <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
           <span>Actividad reciente</span>
           <Link to="/viajes" style={{ fontSize: '0.8rem', fontWeight: 600 }}>Ver más →</Link>
         </div>
         <div className="activity-list">
           {actividad.length === 0 ? (
             <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>No hay actividad reciente.</div>
           ) : (
             actividad.map((act, i) => {
               const esPago = act.tipo === 'pago';
               const texto = esPago
                 ? (accionPagoLabels[act.accion] ?? `pago ${act.accion}`)
                 : `${accionContenedorLabels[act.accion] ?? act.accion.replace('_', ' ')} el contenedor ${act.entidad_id}`;
               const actorNode = act.cliente_telefono ? (
                 <Link to={`/clientes/${encodeURIComponent(act.cliente_telefono)}`} style={{ fontWeight: 600, color: 'inherit' }}>
                   {act.actor}
                 </Link>
               ) : (
                 <strong>{act.actor}</strong>
               );
               return (
                 <div key={i} className="activity-item">
                   <div className="activity-dot" style={{ background: esPago ? 'var(--warning)' : 'var(--success)' }} />
                   <div className="activity-text">
                     {actorNode} {texto}
                     {esPago && act.detalle && <span className="text-muted"> · {act.detalle}</span>}
                   </div>
                   <div className="activity-time">
                     {new Date(act.fecha).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                   </div>
                 </div>
               );
             })
           )}
         </div>
      </div>
    </div>
  );
}
