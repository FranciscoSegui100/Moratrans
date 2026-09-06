import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Package, CircleCheck, CircleDollarSign, Truck, CreditCard, Users, Power, TriangleAlert, type LucideIcon } from 'lucide-react';
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

function KpiCard({ icon: Icon, tint, fg, label, value, extra }: {
  icon: LucideIcon; tint: string; fg: string; label: string; value: number | null; extra?: React.ReactNode;
}) {
  const shown = useCountUp(value);
  return (
    <div className="kpi-card">
      <div className="kpi-icon" style={{ background: tint, color: fg }}><Icon strokeWidth={1.75} /></div>
      <div className="kpi-value">{value === null ? '—' : shown}</div>
      <div className="kpi-label">{label}</div>
      {extra}
    </div>
  );
}

interface Kpis {
  contenedores_activos: number;
  contenedores_disponibles: number;
  cobros_pendientes: number;
  cobros_pendientes_monto: string;
  viajes_hoy: number;
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
  tipo: string;
  entidad_id: string;
  accion: string;
  actor: string;
  fecha: string;
  detalle: string | null;
}

const kpiConfig = [
  { key: 'contenedores_activos',    label: 'Contenedores activos', icon: Package,          tint: 'var(--accent-tint)',  fg: 'var(--accent-dark)' },
  { key: 'contenedores_disponibles',label: 'Disponibles',          icon: CircleCheck,       tint: 'var(--success-bg)',   fg: 'var(--success)' },
  { key: 'cobros_pendientes',       label: 'Cobros pendientes',    icon: CircleDollarSign,  tint: 'var(--warning-bg)',   fg: 'var(--warning)' },
  { key: 'viajes_hoy',              label: 'Viajes de hoy',        icon: Truck,             tint: 'var(--purple-bg)',    fg: 'var(--purple)' },
] as const;

const estadoColors: Record<string, string> = {
  disponible:     'var(--success)',
  reservado:      'var(--accent)',
  entregado:      'var(--purple)',
  retirado:       'var(--neutral)',
  mantenimiento:  'var(--danger)',
};

export function Dashboard() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const { data: kpis = null, isError: kpisError, refetch: refetchKpis } = useQuery({
    queryKey: ['dashboard', 'kpis'],
    queryFn: () => api.get<Kpis>('/api/dashboard/kpis').then((r) => r.data),
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
  const totalContenedores = distribucion.reduce((s, d) => s + d.total, 0) || 1;

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

      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-header">
            <div className="kpi-icon" style={{ background: 'var(--accent-tint)', color: 'var(--accent-dark)' }}><Package strokeWidth={1.75} /></div>
            <div className="kpi-trend" style={{ color: 'var(--success)' }}>▲ 1 hoy</div>
          </div>
          <div className="kpi-value">{kpis ? kpis.contenedores_activos : '—'}</div>
          <div className="kpi-label">Contenedores activos</div>
          <div className="kpi-sparkline">
            {[4, 6, 4, 5, 8, 7, 9].map((v, i) => (
              <div key={i} className="spark-bar" style={{ height: `${v * 10}%`, background: 'var(--accent-tint)' }} />
            ))}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-header">
            <div className="kpi-icon" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}><CircleCheck strokeWidth={1.75} /></div>
            <div className="kpi-trend" style={{ color: 'var(--text-secondary)' }}>= est.</div>
          </div>
          <div className="kpi-value">{kpis ? kpis.contenedores_disponibles : '—'}</div>
          <div className="kpi-label">Disponibles</div>
          <div className="kpi-sparkline">
             {[3, 3, 4, 4, 3, 3, 4].map((v, i) => (
              <div key={i} className="spark-bar" style={{ height: `${v * 10}%`, background: 'var(--success-bg)' }} />
            ))}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-header">
            <div className="kpi-icon" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}><CircleDollarSign strokeWidth={1.75} /></div>
            <div className="kpi-trend" style={{ color: 'var(--text-secondary)' }}>al día</div>
          </div>
          <div className="kpi-value">{kpis ? kpis.cobros_pendientes : '—'}</div>
          <div className="kpi-label">Cobros pendientes</div>
          {kpis && kpis.cobros_pendientes > 0 && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
              ${Number(kpis.cobros_pendientes_monto).toLocaleString('es-AR')} adeudado
            </div>
          )}
          <div className="kpi-sparkline">
             {[1, 1, 1, 1, 1, 1, 1].map((v, i) => (
              <div key={i} className="spark-bar" style={{ height: `10%`, background: 'var(--warning-bg)' }} />
            ))}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-header">
            <div className="kpi-icon" style={{ background: 'var(--purple-bg)', color: 'var(--purple)' }}><Truck strokeWidth={1.75} /></div>
            <div className="kpi-trend" style={{ color: 'var(--success)' }}>▲ 2 vs ayer</div>
          </div>
          <div className="kpi-value">{kpis ? kpis.viajes_hoy : '—'}</div>
          <div className="kpi-label">Viajes de hoy</div>
          <div className="kpi-sparkline">
            {[2, 3, 2, 5, 4, 6, 8].map((v, i) => (
              <div key={i} className="spark-bar" style={{ height: `${v * 10}%`, background: 'var(--purple-bg)' }} />
            ))}
          </div>
        </div>
      </div>

      {/* Distribución de contenedores */}
      <div className="chart-grid">
        <div className="card">
          <div className="section-title">Distribución por estado</div>
          <div style={{ display: 'flex', gap: '20px', alignItems: 'center', marginTop: '16px' }}>
            <div className="donut-chart">
               <div className="donut-center">
                 <div className="donut-value">{totalContenedores}</div>
                 <div className="donut-label">totales</div>
               </div>
               <svg viewBox="0 0 36 36" className="circular-chart">
                 {/* Círculo base */}
                 <path className="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--bg-surface)" strokeWidth="4" />
                 {/* Representación estática por ahora del anillo */}
                 <path className="circle" strokeDasharray="60, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--success)" strokeWidth="4" />
                 <path className="circle" strokeDasharray="25, 100" strokeDashoffset="-60" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--purple)" strokeWidth="4" />
               </svg>
            </div>
            
            <div style={{ flex: 1 }}>
              {distribucion.length === 0 ? (
                <div className="empty-state-text">No hay contenedores cargados</div>
              ) : (
                distribucion.map((d) => (
                  <div key={d.estado} className="estado-bar">
                    <div className="estado-name">
                      <span className="badge-dot" style={{ background: estadoColors[d.estado] || 'var(--accent)' }} />
                      {d.estado.replace('_', ' ')}
                    </div>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${Math.round((d.total / totalContenedores) * 100)}%`,
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
              { href: '/pagos',       icon: CreditCard, label: 'Validar pagos pendientes' },
              { href: '/viajes',      icon: Truck,      label: 'Programar viaje' },
              { href: '/contenedores',icon: Package,    label: 'Gestionar contenedores' },
              { href: '/choferes',    icon: Users,      label: 'Alta de chofer' },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} to={item.href} className="quick-access-btn">
                  <div className="quick-access-icon"><Icon size={16} strokeWidth={1.75} /></div>
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: '16px' }}>
         <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
           <span>Actividad Reciente</span>
           <Link to="/viajes" style={{ fontSize: '0.8rem', fontWeight: 600 }}>Ver más →</Link>
         </div>
         <div className="activity-list">
           {actividad.length === 0 ? (
             <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>No hay actividad reciente.</div>
           ) : (
             actividad.map((act, i) => (
               <div key={i} className="activity-item">
                 <div className="activity-dot" style={{ background: act.tipo === 'pago' ? 'var(--warning)' : 'var(--success)' }} />
                 <div className="activity-text">
                   <strong>{act.actor}</strong> {act.tipo === 'pago' ? 'registró un pago' : `marcó un contenedor como ${act.accion.replace('_', ' ')}`} {act.entidad_id}
                 </div>
                 <div className="activity-time">
                   {new Date(act.fecha).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                 </div>
               </div>
             ))
           )}
         </div>
      </div>
    </div>
  );
}
