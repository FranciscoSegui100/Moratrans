import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Package, CircleCheck, CircleDollarSign, Truck, CreditCard, Users, Power, TriangleAlert } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

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
        {kpiConfig.map((c) => {
          const Icon = c.icon;
          return (
            <div key={c.key} className="kpi-card">
              <div className="kpi-icon" style={{ background: c.tint, color: c.fg }}><Icon strokeWidth={1.75} /></div>
              <div className="kpi-value">
                {kpis ? (kpis as any)[c.key] : '—'}
              </div>
              <div className="kpi-label">{c.label}</div>
              {c.key === 'cobros_pendientes' && kpis && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  ${Number(kpis.cobros_pendientes_monto).toLocaleString('es-AR')} adeudado
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Distribución de contenedores */}
      <div className="chart-grid">
        <div className="card">
          <div className="section-title">Distribución por estado</div>
          {distribucion.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon"><Package strokeWidth={1.5} /></div>
              <div className="empty-state-title">{distribucionError ? 'No se pudo cargar' : 'Sin datos'}</div>
              <div className="empty-state-text">
                {distribucionError ? 'Hubo un error al pedir la distribución de contenedores.' : 'No hay contenedores cargados'}
              </div>
            </div>
          ) : (
            distribucion.map((d) => (
              <div key={d.estado} className="estado-bar">
                <div className="estado-name">
                  <span className={`badge ${d.estado}`}>{d.estado.replace('_', ' ')}</span>
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
                <Link
                  key={item.href}
                  to={item.href}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '10px 12px',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--text-secondary)',
                    textDecoration: 'none',
                    fontSize: '0.83rem',
                    fontWeight: 500,
                    transition: 'all var(--transition)',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
                >
                  <Icon size={16} strokeWidth={1.75} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
