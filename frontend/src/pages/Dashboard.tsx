import { useEffect, useState } from 'react';
import { api } from '../api/client';

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

const kpiConfig = [
  { key: 'contenedores_activos',    label: 'Contenedores activos', icon: '📦', color: 'blue' },
  { key: 'contenedores_disponibles',label: 'Disponibles',          icon: '✅', color: 'green' },
  { key: 'cobros_pendientes',       label: 'Cobros pendientes',    icon: '💰', color: 'yellow' },
  { key: 'viajes_hoy',              label: 'Viajes de hoy',        icon: '🚛', color: 'purple' },
] as const;

const estadoColors: Record<string, string> = {
  disponible:     'var(--success)',
  reservado:      'var(--accent)',
  en_camino:      'var(--warning)',
  entregado:      'var(--purple)',
  retirado:       '#94a3b8',
  mantenimiento:  'var(--danger)',
};

export function Dashboard() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [distribucion, setDistribucion] = useState<EstadoDist[]>([]);

  useEffect(() => {
    api.get<Kpis>('/api/dashboard/kpis').then((r) => setKpis(r.data)).catch(() => {});
    api.get<EstadoDist[]>('/api/dashboard/contenedores').then((r) => setDistribucion(r.data)).catch(() => {});
  }, []);

  const totalContenedores = distribucion.reduce((s, d) => s + d.total, 0) || 1;

  return (
    <div>
      <div className="page-header">
        <h2>Dashboard</h2>
        <p>Resumen general del sistema logístico</p>
      </div>

      {/* KPI Cards */}
      <div className="kpi-grid">
        {kpiConfig.map((c) => (
          <div key={c.key} className={`kpi-card ${c.color}`}>
            <div className={`kpi-icon ${c.color}`}>{c.icon}</div>
            <div className="kpi-value">
              {kpis ? (kpis as any)[c.key] : '—'}
            </div>
            <div className="kpi-label">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Distribución de contenedores */}
      <div className="chart-grid">
        <div className="card">
          <div className="section-title">Distribución por estado</div>
          {distribucion.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📦</div>
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
              { href: '/pagos',       icon: '💳', label: 'Validar pagos pendientes' },
              { href: '/viajes',      icon: '🚛', label: 'Programar viaje' },
              { href: '/contenedores',icon: '📦', label: 'Gestionar contenedores' },
              { href: '/choferes',    icon: '👷', label: 'Alta de chofer' },
              { href: '/reportes',    icon: '📄', label: 'Exportar reportes' },
            ].map((item) => (
              <a
                key={item.href}
                href={item.href}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  color: 'var(--text-secondary)',
                  textDecoration: 'none',
                  fontSize: '0.87rem',
                  fontWeight: 500,
                  transition: 'all var(--transition)',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
              >
                <span style={{ fontSize: '1.1rem' }}>{item.icon}</span>
                {item.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
