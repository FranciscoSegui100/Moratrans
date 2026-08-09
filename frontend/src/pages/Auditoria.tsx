import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { authEventoLabel } from '../lib/authEventLabels';

interface EventoAuth {
  id: string;
  usuario_id: string | null;
  email: string | null;
  tipo: string;
  ip: string | null;
  user_agent: string | null;
  detalle: Record<string, unknown> | null;
  creado_en: string;
}

const EVENTOS_RIESGO = new Set(['login_fallido', 'mfa_fallido', 'bloqueo_temporal', 'refresh_reutilizado', 'sesion_revocada']);
const EVENTOS_OK = new Set(['login_exitoso', 'mfa_activado', 'password_reset_exitoso']);

const LIMIT = 50;

export function Auditoria() {
  const [eventos, setEventos] = useState<EventoAuth[]>([]);
  const [offset, setOffset] = useState(0);
  const [hayMas, setHayMas] = useState(true);
  const [loadingMas, setLoadingMas] = useState(false);
  const [filtroTipo, setFiltroTipo] = useState('');
  const [filtroEmail, setFiltroEmail] = useState('');
  const [filtrosAplicados, setFiltrosAplicados] = useState({ tipo: '', email: '' });

  // Primera página cacheada por filtro: al revisitar la pestaña con el mismo
  // filtro se muestra al instante en lo que se revalida en segundo plano.
  const { data: primeraPagina = [], isFetching: cargandoPrimera } = useQuery({
    queryKey: ['auditoria', filtrosAplicados.tipo, filtrosAplicados.email],
    queryFn: () => api.get<EventoAuth[]>('/api/auditoria', {
      params: { limit: LIMIT, offset: 0, tipo: filtrosAplicados.tipo || undefined, email: filtrosAplicados.email || undefined },
    }).then((r) => r.data),
  });

  // La paginación ("cargar más") es local: se reinicia cada vez que llega una primera página nueva.
  useEffect(() => {
    setEventos(primeraPagina);
    setOffset(primeraPagina.length);
    setHayMas(primeraPagina.length === LIMIT);
  }, [primeraPagina]);

  async function cargarMas() {
    setLoadingMas(true);
    try {
      const { data } = await api.get<EventoAuth[]>('/api/auditoria', {
        params: { limit: LIMIT, offset, tipo: filtrosAplicados.tipo || undefined, email: filtrosAplicados.email || undefined },
      });
      setEventos((prev) => [...prev, ...data]);
      setOffset((o) => o + LIMIT);
      setHayMas(data.length === LIMIT);
    } finally {
      setLoadingMas(false);
    }
  }

  function onFiltrar(e: React.FormEvent) {
    e.preventDefault();
    setFiltrosAplicados({ tipo: filtroTipo, email: filtroEmail });
  }

  return (
    <div>
      <div className="page-header">
        <h2>Auditoría</h2>
        <p>Actividad de autenticación de todo el panel</p>
      </div>

      <form onSubmit={onFiltrar} className="form-card form-row" style={{ marginBottom: '16px' }}>
        <div className="form-group">
          <label className="form-label">Tipo de evento</label>
          <select className="form-select" value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(authEventoLabel).map(([tipo, label]) => (
              <option key={tipo} value={tipo}>{label}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" placeholder="Buscar por email" value={filtroEmail} onChange={(e) => setFiltroEmail(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={cargandoPrimera}>Filtrar</button>
      </form>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Evento</th>
              <th>Usuario</th>
              <th>IP</th>
              <th>Dispositivo</th>
            </tr>
          </thead>
          <tbody>
            {eventos.map((ev) => {
              const claseBadge = EVENTOS_RIESGO.has(ev.tipo) ? 'cancelado' : EVENTOS_OK.has(ev.tipo) ? 'disponible' : 'programado';
              return (
                <tr key={ev.id}>
                  <td className="text-muted">{new Date(ev.creado_en).toLocaleString('es-AR')}</td>
                  <td><span className={`badge ${claseBadge}`}>{authEventoLabel[ev.tipo] ?? ev.tipo}</span></td>
                  <td>{ev.email ?? <span className="text-muted">—</span>}</td>
                  <td className="text-muted">{ev.ip ?? '—'}</td>
                  <td className="text-muted" style={{ maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ev.user_agent ?? ''}>
                    {ev.user_agent ?? '—'}
                  </td>
                </tr>
              );
            })}
            {eventos.length === 0 && !cargandoPrimera && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  Sin eventos para este filtro
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {hayMas && eventos.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <button className="btn btn-ghost" onClick={cargarMas} disabled={loadingMas}>
            {loadingMas ? 'Cargando...' : 'Cargar más'}
          </button>
        </div>
      )}
    </div>
  );
}
