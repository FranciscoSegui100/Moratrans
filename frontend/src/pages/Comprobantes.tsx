import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Receipt, Search } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { formatearFechaHora } from '../lib/fechas';

interface Comprobante {
  id: string;
  cliente_telefono: string;
  cliente_nombre: string | null;
  monto: string | null;
  estado: string;
  tipo: 'flete' | 'alargue_retiro';
  creado_en: string;
  titular_transferencia: string | null;
  zona: string | null;
  precio: string | null;
}

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

interface GrupoMes {
  key: string;
  label: string;
  items: Comprobante[];
}

/** Agrupa los comprobantes por mes calendario (hora local), manteniendo el orden
 *  "más nuevos primero" que ya trae el endpoint. */
function agruparPorMes(comprobantes: Comprobante[]): GrupoMes[] {
  const grupos: GrupoMes[] = [];
  for (const c of comprobantes) {
    const d = new Date(c.creado_en);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    let g = grupos.find((x) => x.key === key);
    if (!g) {
      g = { key, label: `${MESES[d.getMonth()]} ${d.getFullYear()}`, items: [] };
      grupos.push(g);
    }
    g.items.push(c);
  }
  return grupos;
}

/** Match por teléfono O por nombre (indistinto). El término se compara tal cual
 *  y también solo-dígitos, para que "261 555" encuentre "...261555...". */
function coincide(c: Comprobante, termino: string): boolean {
  const q = termino.trim().toLowerCase();
  if (!q) return true;
  const nombre = (c.cliente_nombre ?? '').toLowerCase();
  const tel = c.cliente_telefono.toLowerCase();
  if (nombre.includes(q) || tel.includes(q)) return true;
  const digitos = q.replace(/\D/g, '');
  return digitos.length > 0 && c.cliente_telefono.replace(/\D/g, '').includes(digitos);
}

function ComprobanteCard({ c }: { c: Comprobante }) {
  return (
    <div className="pago-card">
      <div className="pago-card-top">
        <div className="pago-avatar"><Receipt strokeWidth={1.75} /></div>
        <div className="pago-info">
          <div className="pago-phone">
            {c.cliente_nombre ? `${c.cliente_nombre} · ${c.cliente_telefono}` : c.cliente_telefono}{' '}
            <span className={`badge ${c.estado}`} style={{ marginLeft: '6px' }}>{c.estado}</span>
          </div>
          <div className="pago-detail">
            {c.tipo === 'alargue_retiro' ? '⏳ Alargue de retiro' : (c.zona ?? 'Sin zona')} ·{' '}
            {c.precio
              ? `ARS ${Number(c.precio).toLocaleString('es-AR')}`
              : c.monto
              ? `ARS ${Number(c.monto).toLocaleString('es-AR')}`
              : 'Sin monto'}{' '}
            · {formatearFechaHora(c.creado_en)}
          </div>
          {c.titular_transferencia && (
            <div className="pago-detail">Transferencia a nombre de: <strong>{c.titular_transferencia}</strong></div>
          )}
          <RoleGate roles={['admin', 'operador', 'finanzas']}>
            <ComprobanteViewer pagoId={c.id} />
          </RoleGate>
        </div>
      </div>
    </div>
  );
}

/** Un mes = una tarjeta con su propio buscador, que filtra SOLO ese mes. */
function SeccionMes({ label, items }: { label: string; items: Comprobante[] }) {
  const [q, setQ] = useState('');
  const buscando = q.trim().length > 0;
  const filtrados = buscando ? items.filter((c) => coincide(c, q)) : items;

  return (
    <div className="card">
      <div
        className="section-title"
        style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Receipt size={16} strokeWidth={1.75} />
          {label}
          <span className="badge programado" style={{ fontSize: '0.72rem' }}>
            {buscando ? `${filtrados.length}/${items.length}` : items.length}
          </span>
        </span>
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <Search
            size={14}
            strokeWidth={1.75}
            style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', opacity: 0.5, pointerEvents: 'none' }}
          />
          <input
            className="form-input"
            style={{ width: 230, paddingLeft: 28, fontSize: '0.82rem' }}
            placeholder="Buscar por teléfono o nombre"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {filtrados.length === 0 ? (
        <p className="text-muted" style={{ margin: 0 }}>
          Sin comprobantes de “{q.trim()}” en {label}.
        </p>
      ) : (
        <div className="space-y">
          {filtrados.map((c) => <ComprobanteCard key={c.id} c={c} />)}
        </div>
      )}
    </div>
  );
}

export function Comprobantes() {
  const { data: comprobantes = [] } = useQuery({
    queryKey: ['dashboard', 'comprobantes'],
    queryFn: () => api.get<Comprobante[]>('/api/dashboard/comprobantes').then((r) => r.data),
  });

  const grupos = useMemo(() => agruparPorMes(comprobantes), [comprobantes]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Comprobantes</h2>
          <p style={{ fontSize: '1rem' }}>Histórico de comprobantes de pago enviados por los clientes</p>
        </div>
      </div>

      {comprobantes.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><Receipt strokeWidth={1.5} /></div>
            <div className="empty-state-title">Sin comprobantes</div>
            <div className="empty-state-text">Todavía no llegó ningún comprobante de pago</div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {grupos.map((g) => <SeccionMes key={g.key} label={g.label} items={g.items} />)}
        </div>
      )}
    </div>
  );
}
