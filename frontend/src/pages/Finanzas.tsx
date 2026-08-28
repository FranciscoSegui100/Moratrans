import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DollarSign, Package, RefreshCw, Clock, Download, ShieldAlert } from 'lucide-react';
import { api, descargarArchivo } from '../api/client';
import { useAuth, tieneRol } from '../context/AuthContext';

interface ResumenMes {
  mes: string;
  entregas: number;
  recambios: number;
  alargues: number;
  total: number;
  cantidad: number;
}
interface Resumen {
  anio: number;
  meses: ResumenMes[];
  total: number;
}

const NOMBRE_MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function formatoMoneda(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function Finanzas() {
  const { user } = useAuth();
  const anioActual = new Date().getFullYear();
  const [anio, setAnio] = useState(anioActual);
  const [descargando, setDescargando] = useState(false);
  const esFinanzas = tieneRol(user, 'admin', 'finanzas');

  const { data: resumen, isLoading } = useQuery({
    queryKey: ['finanzas', 'resumen', anio],
    queryFn: () => api.get<Resumen>(`/api/finanzas/resumen?anio=${anio}`).then((r) => r.data),
    enabled: esFinanzas,
  });

  if (!esFinanzas) {
    return (
      <div>
        <div className="page-header">
          <h2>Finanzas</h2>
          <p>Resumen de ingresos mensuales</p>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon"><ShieldAlert strokeWidth={1.5} /></div>
          <div className="empty-state-title">Acceso restringido</div>
          <div className="empty-state-text">Esta sección es solo para administradores y finanzas.</div>
        </div>
      </div>
    );
  }

  async function descargarExcel() {
    setDescargando(true);
    try {
      await descargarArchivo(`/api/finanzas/excel?anio=${anio}`, `moratrans-ingresos-${anio}.xlsx`);
    } finally {
      setDescargando(false);
    }
  }

  const totalEntregas = resumen?.meses.reduce((s, m) => s + m.entregas, 0) ?? 0;
  const totalRecambios = resumen?.meses.reduce((s, m) => s + m.recambios, 0) ?? 0;
  const totalAlargues = resumen?.meses.reduce((s, m) => s + m.alargues, 0) ?? 0;
  const totalCantidad = resumen?.meses.reduce((s, m) => s + m.cantidad, 0) ?? 0;
  const maxTotal = Math.max(1, ...(resumen?.meses.map((m) => m.total) ?? [1]));

  const kpis = [
    { label: `Ingresos ${anio}`, value: formatoMoneda(resumen?.total ?? 0), icon: DollarSign },
    { label: 'Entregas', value: formatoMoneda(totalEntregas), icon: Package },
    { label: 'Recambios', value: formatoMoneda(totalRecambios), icon: RefreshCw },
    { label: 'Alargues de retiro', value: formatoMoneda(totalAlargues), icon: Clock },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Finanzas</h2>
          <p>Resumen de ingresos mensuales — entregas, recambios y alargues de retiro</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <select className="form-select" value={anio} onChange={(e) => setAnio(Number(e.target.value))} style={{ width: 'auto' }}>
            {Array.from({ length: 5 }, (_, i) => anioActual - i).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" onClick={descargarExcel} disabled={descargando}>
            <Download size={16} strokeWidth={1.75} /> {descargando ? 'Generando...' : 'Exportar a Excel'}
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="kpi-card">
              <div className="kpi-icon"><Icon strokeWidth={1.75} /></div>
              <div className="kpi-value">{isLoading ? '—' : k.value}</div>
              <div className="kpi-label">{k.label}</div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="section-title">Ingresos por mes — {anio}</div>
        {isLoading ? (
          <p className="text-muted">Cargando…</p>
        ) : (
          <div className="space-y">
            {resumen?.meses.map((m) => (
              <div key={m.mes} className="estado-bar">
                <div className="estado-name" style={{ minWidth: '48px' }}>
                  {NOMBRE_MES[Number(m.mes.slice(5, 7)) - 1]}
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${Math.round((m.total / maxTotal) * 100)}%`, background: 'var(--accent)' }}
                  />
                </div>
                <div className="estado-count" style={{ minWidth: '110px', textAlign: 'right' }}>
                  {formatoMoneda(m.total)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Mes</th>
              <th>Entregas</th>
              <th>Recambios</th>
              <th>Alargues de retiro</th>
              <th>Total</th>
              <th>Movimientos</th>
            </tr>
          </thead>
          <tbody>
            {resumen?.meses.map((m) => (
              <tr key={m.mes}>
                <td className="strong">{NOMBRE_MES[Number(m.mes.slice(5, 7)) - 1]} {anio}</td>
                <td>{formatoMoneda(m.entregas)}</td>
                <td>{formatoMoneda(m.recambios)}</td>
                <td>{formatoMoneda(m.alargues)}</td>
                <td className="strong">{formatoMoneda(m.total)}</td>
                <td className="text-muted">{m.cantidad}</td>
              </tr>
            ))}
            {resumen && (
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                <td>TOTAL {anio}</td>
                <td>{formatoMoneda(totalEntregas)}</td>
                <td>{formatoMoneda(totalRecambios)}</td>
                <td>{formatoMoneda(totalAlargues)}</td>
                <td>{formatoMoneda(resumen.total)}</td>
                <td className="text-muted">{totalCantidad}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
