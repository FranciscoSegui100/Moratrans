import { descargarArchivo } from '../api/client';

const reportes = [
  {
    id: 'excel',
    icon: '📊',
    label: 'Contenedores (Excel)',
    desc: 'Estado completo del inventario de contenedores',
    action: () => descargarArchivo('/api/reportes/contenedores.xlsx', 'contenedores.xlsx'),
    color: 'var(--success)',
    bg: 'var(--success-bg)',
  },
  {
    id: 'pdf',
    icon: '📄',
    label: 'Resumen de pagos (PDF)',
    desc: 'Historial de pagos sin datos sensibles',
    action: () => descargarArchivo('/api/reportes/pagos.pdf', 'pagos.pdf'),
    color: 'var(--danger)',
    bg: 'var(--danger-bg)',
  },
];

export function Reportes() {
  return (
    <div>
      <div className="page-header">
        <h2>Reportes</h2>
        <p>Generados en tiempo real desde la base de datos. Sin datos sensibles.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
        {reportes.map((r) => (
          <button
            key={r.id}
            onClick={r.action}
            style={{
              background: 'var(--bg-card)',
              border: `1px solid var(--border)`,
              borderRadius: 'var(--radius-lg)',
              padding: '24px',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'all var(--transition)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = r.color;
              (e.currentTarget as HTMLElement).style.boxShadow = `0 0 20px ${r.bg}`;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
              (e.currentTarget as HTMLElement).style.boxShadow = 'none';
            }}
          >
            <div
              style={{
                width: '48px',
                height: '48px',
                borderRadius: 'var(--radius)',
                background: r.bg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.5rem',
              }}
            >
              {r.icon}
            </div>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>{r.label}</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{r.desc}</div>
            </div>
            <div style={{ color: r.color, fontSize: '0.82rem', fontWeight: 600 }}>
              ↓ Descargar
            </div>
          </button>
        ))}
      </div>

      <div style={{ marginTop: '24px', padding: '16px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
        <p className="text-muted">
          ℹ️ Los reportes se generan al momento. No incluyen URLs de comprobantes ni DNIs en claro (cifrado AES-256 en reposo).
        </p>
      </div>
    </div>
  );
}
