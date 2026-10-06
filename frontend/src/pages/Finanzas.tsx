import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DollarSign, Package, RefreshCw, Clock, Download, ShieldAlert, Mail, X } from 'lucide-react';
import { api, descargarArchivo } from '../api/client';
import { useAuth, tieneRol } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { RoleGate } from '../components/RoleGate';

interface ResumenMes {
  mes: string;
  entregas: number;
  recambios: number;
  alargues: number;
  otros: number;
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

const otroIngresoVacio = { telefono: '', monto: '', medio_pago: 'transferencia' as 'transferencia' | 'efectivo', concepto: '' };

export function Finanzas() {
  const { user } = useAuth();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const anioActual = new Date().getFullYear();
  const [anio, setAnio] = useState(anioActual);
  const [descargando, setDescargando] = useState(false);
  const [mostrarOtroIngreso, setMostrarOtroIngreso] = useState(false);
  const [otroIngresoForm, setOtroIngresoForm] = useState(otroIngresoVacio);
  const [guardandoOtroIngreso, setGuardandoOtroIngreso] = useState(false);
  const esFinanzas = tieneRol(user, 'admin', 'finanzas');

  const { data: resumen, isLoading } = useQuery({
    queryKey: ['finanzas', 'resumen', anio],
    queryFn: () => api.get<Resumen>(`/api/finanzas/resumen?anio=${anio}`).then((r) => r.data),
    enabled: esFinanzas,
  });

  /** Ingreso por un servicio fuera del alquiler de contenedores (lo cerró un asesor por WhatsApp, ver asesor.flow.ts) — se carga a mano, sin comprobante. */
  async function registrarOtroIngreso() {
    const monto = Number(otroIngresoForm.monto);
    if (!(monto > 0)) return show('error', 'Monto inválido');
    if (otroIngresoForm.telefono.trim().length < 6) return show('error', 'Falta el teléfono del cliente');
    if (!otroIngresoForm.concepto.trim()) return show('error', 'Contá brevemente qué servicio fue');
    setGuardandoOtroIngreso(true);
    try {
      await api.post('/api/pagos/otro-ingreso', {
        telefono: otroIngresoForm.telefono.trim(),
        monto,
        medio_pago: otroIngresoForm.medio_pago,
        concepto: otroIngresoForm.concepto.trim(),
      });
      queryClient.invalidateQueries({ queryKey: ['finanzas', 'resumen'] });
      setMostrarOtroIngreso(false);
      setOtroIngresoForm(otroIngresoVacio);
      show('success', 'Ingreso registrado');
    } catch (err: any) {
      show('error', 'No se pudo guardar', err.response?.data?.error);
    } finally {
      setGuardandoOtroIngreso(false);
    }
  }

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
  const totalOtros = resumen?.meses.reduce((s, m) => s + m.otros, 0) ?? 0;
  const totalCantidad = resumen?.meses.reduce((s, m) => s + m.cantidad, 0) ?? 0;
  const maxTotal = Math.max(1, ...(resumen?.meses.map((m) => m.total) ?? [1]));

  const kpis = [
    { label: `Ingresos ${anio}`, value: formatoMoneda(resumen?.total ?? 0), icon: DollarSign },
    { label: 'Entregas', value: formatoMoneda(totalEntregas), icon: Package },
    { label: 'Recambios', value: formatoMoneda(totalRecambios), icon: RefreshCw },
    { label: 'Alargues de retiro', value: formatoMoneda(totalAlargues), icon: Clock },
    { label: 'Otros servicios', value: formatoMoneda(totalOtros), icon: Mail },
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
          <RoleGate roles={['admin', 'operador', 'finanzas']}>
            <button className="btn btn-success btn-sm" onClick={() => setMostrarOtroIngreso(true)}>
              <Mail size={16} strokeWidth={1.75} /> Registrar otro ingreso
            </button>
          </RoleGate>
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
              <th>Otros servicios</th>
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
                <td>{formatoMoneda(m.otros)}</td>
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
                <td>{formatoMoneda(totalOtros)}</td>
                <td>{formatoMoneda(resumen.total)}</td>
                <td className="text-muted">{totalCantidad}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {mostrarOtroIngreso && (
        <div className="modal-overlay" onClick={() => !guardandoOtroIngreso && setMostrarOtroIngreso(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="section-title" style={{ margin: 0 }}>Registrar otro ingreso</div>
              <button className="modal-close" onClick={() => setMostrarOtroIngreso(false)}>
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            <p className="text-muted" style={{ marginTop: 0 }}>
              Para un servicio fuera del alquiler de contenedores que cerró un asesor por WhatsApp — ya cobrado, sin comprobante.
            </p>

            <div className="form-group">
              <label className="form-label">Teléfono del cliente</label>
              <input
                className="form-input"
                placeholder="Ej. 5493794123456"
                value={otroIngresoForm.telefono}
                onChange={(e) => setOtroIngresoForm({ ...otroIngresoForm, telefono: e.target.value })}
                autoFocus
              />
            </div>

            <div className="form-group">
              <label className="form-label">Qué servicio fue</label>
              <input
                className="form-input"
                placeholder="Ej. venta de contenedor, depósito..."
                value={otroIngresoForm.concepto}
                onChange={(e) => setOtroIngresoForm({ ...otroIngresoForm, concepto: e.target.value })}
              />
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '1 1 160px' }}>
                <label className="form-label">Monto</label>
                <input
                  type="number" min="0" step="0.01"
                  className="form-input"
                  placeholder="$"
                  value={otroIngresoForm.monto}
                  onChange={(e) => setOtroIngresoForm({ ...otroIngresoForm, monto: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ flex: '1 1 160px' }}>
                <label className="form-label">Medio de pago</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {([
                    ['transferencia', 'Transferencia'],
                    ['efectivo', 'Efectivo'],
                  ] as const).map(([valor, etiqueta]) => (
                    <button
                      key={valor}
                      type="button"
                      className={`btn btn-sm ${otroIngresoForm.medio_pago === valor ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setOtroIngresoForm({ ...otroIngresoForm, medio_pago: valor })}
                    >
                      {etiqueta}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button className="btn btn-ghost" onClick={() => setMostrarOtroIngreso(false)} disabled={guardandoOtroIngreso}>Cancelar</button>
              <button className="btn btn-success" onClick={registrarOtroIngreso} disabled={guardandoOtroIngreso}>
                {guardandoOtroIngreso ? 'Guardando...' : 'Registrar ingreso'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
