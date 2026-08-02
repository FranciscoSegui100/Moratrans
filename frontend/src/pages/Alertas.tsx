import { useAlertas } from '../hooks/useAlertas';

const tipoLabel: Record<string, string> = {
  contenedor_por_vencer:      'Contenedor por vencer',
  pago_vencido:               'Pago vencido',
  pago_pendiente_validacion:  'Pago pendiente',
  chofer_no_reconocido:       'Chofer no reconocido',
  stock_bajo:                 'Stock bajo',
};

export function Alertas() {
  const { alertas, resolver } = useAlertas();

  return (
    <div>
      <div className="page-header">
        <h2>
          Bandeja de alertas
          <span className="live-badge">
            <span className="live-dot" />
            en vivo
          </span>
        </h2>
        <p>{alertas.length} alerta{alertas.length !== 1 ? 's' : ''} activa{alertas.length !== 1 ? 's' : ''}</p>
      </div>

      {alertas.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">🟢</div>
            <div className="empty-state-title">Sin alertas activas</div>
            <div className="empty-state-text">El sistema está funcionando correctamente</div>
          </div>
        </div>
      ) : (
        <div className="space-y">
          {alertas.map((a) => (
            <div key={a.id} className={`alerta-card alerta-${a.tipo}`}>
              <div>
                <div className="alerta-tipo">{tipoLabel[a.tipo] ?? a.tipo}</div>
                <div className="alerta-msg">{a.mensaje}</div>
                <div className="alerta-time">{new Date(a.creado_en).toLocaleString('es-UY')}</div>
              </div>
              <button
                onClick={() => resolver(a.id)}
                className="btn btn-ghost btn-sm"
              >
                ✓ Resolver
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
