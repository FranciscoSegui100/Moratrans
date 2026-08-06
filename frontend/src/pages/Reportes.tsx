import { Sheet, FileText, Download, Info } from 'lucide-react';
import { descargarArchivo } from '../api/client';

const reportes = [
  {
    id: 'excel',
    icon: Sheet,
    label: 'Contenedores (Excel)',
    desc: 'Estado completo del inventario de contenedores',
    action: () => descargarArchivo('/api/reportes/contenedores.xlsx', 'contenedores.xlsx'),
  },
  {
    id: 'pdf',
    icon: FileText,
    label: 'Resumen de pagos (PDF)',
    desc: 'Historial de pagos sin datos sensibles',
    action: () => descargarArchivo('/api/reportes/pagos.pdf', 'pagos.pdf'),
  },
];

export function Reportes() {
  return (
    <div>
      <div className="page-header">
        <h2>Reportes</h2>
        <p>Generados en tiempo real desde la base de datos. Sin datos sensibles.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1px', background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        {reportes.map((r) => {
          const Icon = r.icon;
          return (
            <button
              key={r.id}
              onClick={r.action}
              style={{
                background: 'var(--bg-card)',
                border: 'none',
                padding: '20px',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background var(--transition)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-card-hover)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)'; }}
            >
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-surface)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-secondary)',
                }}
              >
                <Icon size={16} strokeWidth={1.75} />
              </div>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '3px', fontSize: '0.87rem' }}>{r.label}</div>
                <div style={{ fontSize: '0.79rem', color: 'var(--text-muted)' }}>{r.desc}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--accent)', fontSize: '0.79rem', fontWeight: 600 }}>
                <Download size={13} strokeWidth={2} /> Descargar
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: '20px', padding: '12px 16px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
        <Info size={15} strokeWidth={1.75} style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: '1px' }} />
        <p className="text-muted">
          Los reportes se generan al momento. No incluyen URLs de comprobantes ni DNIs en claro (cifrado AES-256 en reposo).
        </p>
      </div>
    </div>
  );
}
