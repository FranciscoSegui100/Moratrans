import { useQuery } from '@tanstack/react-query';
import { Package, CircleCheck, CircleDollarSign, Truck, CreditCard, Users, Receipt } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { formatearFechaHora } from '../lib/fechas';

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

interface ComprobanteMes {
  id: string;
  cliente_telefono: string;
  monto: string | null;
  estado: string;
  tipo: 'flete' | 'alargue_retiro';
  creado_en: string;
  titular_transferencia: string | null;
  zona: string | null;
  precio: string | null;
  moneda: string | null;
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
  const { data: kpis = null } = useQuery({
    queryKey: ['dashboard', 'kpis'],
    queryFn: () => api.get<Kpis>('/api/dashboard/kpis').then((r) => r.data),
  });
  const { data: distribucion = [] } = useQuery({
    queryKey: ['dashboard', 'contenedores'],
    queryFn: () => api.get<EstadoDist[]>('/api/dashboard/contenedores').then((r) => r.data),
  });
  const { data: comprobantesMes = [] } = useQuery({
    queryKey: ['dashboard', 'comprobantes-mes'],
    queryFn: () => api.get<ComprobanteMes[]>('/api/dashboard/comprobantes-mes').then((r) => r.data),
  });

  const totalContenedores = distribucion.reduce((s, d) => s + d.total, 0) || 1;
  const nombreMesActual = (() => {
    const t = new Date().toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  })();

  return (
    <div>
      <div className="page-header">
        <h2>Dashboard</h2>
        <p>Resumen general del sistema logístico</p>
      </div>

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

      {/* Comprobantes del mes actual */}
      <div className="card" style={{ marginTop: '16px' }}>
        <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Receipt size={16} strokeWidth={1.75} />
          Comprobantes — {nombreMesActual}
          <span className="badge programado" style={{ fontSize: '0.72rem' }}>{comprobantesMes.length}</span>
        </div>

        {comprobantesMes.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Receipt strokeWidth={1.5} /></div>
            <div className="empty-state-title">Sin comprobantes este mes</div>
            <div className="empty-state-text">Todavía no llegó ningún comprobante de pago en {nombreMesActual.toLowerCase()}</div>
          </div>
        ) : (
          <div className="space-y" style={{ maxHeight: '480px', overflowY: 'auto' }}>
            {comprobantesMes.map((c) => (
              <div key={c.id} className="pago-card">
                <div className="pago-card-top">
                  <div className="pago-avatar"><Receipt strokeWidth={1.75} /></div>
                  <div className="pago-info">
                    <div className="pago-phone">
                      {c.cliente_telefono}{' '}
                      <span className={`badge ${c.estado}`} style={{ marginLeft: '6px' }}>{c.estado}</span>
                    </div>
                    <div className="pago-detail">
                      {c.tipo === 'alargue_retiro' ? '⏳ Alargue de retiro' : (c.zona ?? 'Sin zona')} ·{' '}
                      {c.precio
                        ? `${c.moneda ?? ''} ${Number(c.precio).toLocaleString('es-AR')}`.trim()
                        : c.monto
                        ? `${c.moneda ?? ''} ${Number(c.monto).toLocaleString('es-AR')}`.trim()
                        : 'Sin monto'}{' '}
                      · {formatearFechaHora(c.creado_en)}
                    </div>
                    {c.titular_transferencia && (
                      <div className="pago-detail">Transferencia a nombre de: <strong>{c.titular_transferencia}</strong></div>
                    )}
                    <RoleGate roles={['admin', 'finanzas']}>
                      <ComprobanteViewer pagoId={c.id} />
                    </RoleGate>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
