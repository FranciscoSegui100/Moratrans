import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Package, CircleCheck, CircleDollarSign, Truck, CreditCard, Users, Power, TriangleAlert } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Kpis {
  contenedores_activos: number;
  contenedores_disponibles: number;
  cobros_pendientes: number;
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
  { key: 'contenedores_activos',    label: 'Contenedores activos', icon: Package },
  { key: 'contenedores_disponibles',label: 'Disponibles',          icon: CircleCheck },
  { key: 'cobros_pendientes',       label: 'Cobros pendientes',    icon: CircleDollarSign },
  { key: 'viajes_hoy',              label: 'Viajes de hoy',        icon: Truck },
] as const;

const estadoColors: Record<string, string> = {
  disponible:     'var(--success)',
  reservado:      'var(--accent)',
  entregado:      'var(--purple)',
  retirado:       '#94a3b8',
  mantenimiento:  'var(--danger)',
};

export function Dashboard() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const { data: kpis = null } = useQuery({
    queryKey: ['dashboard', 'kpis'],
    queryFn: () => api.get<Kpis>('/api/dashboard/kpis').then((r) => r.data),
  });
  const { data: distribucion = [] } = useQuery({
    queryKey: ['dashboard', 'contenedores'],
    queryFn: () => api.get<EstadoDist[]>('/api/dashboard/contenedores').then((r) => r.data),
  });
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
              <div className="kpi-icon"><Icon strokeWidth={1.75} /></div>
              <div className="kpi-value">
                {kpis ? (kpis as any)[c.key] : '—'}
              </div>
              <div className="kpi-label">{c.label}</div>
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
              <div className="empty-state-title">Sin datos</div>
              <div className="empty-state-text">No hay contenedores cargados</div>
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
                <a
                  key={item.href}
                  href={item.href}
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
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
