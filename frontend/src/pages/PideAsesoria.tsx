import { useEffect, useState } from 'react';
import { Check, MessageCircle } from 'lucide-react';
import { useAlertas } from '../hooks/useAlertas';
import { RoleGate } from '../components/RoleGate';
import { ChatAsesor } from '../components/ChatAsesor';

/** Bandeja estilo WhatsApp: lista de clientes que pidieron un asesor + hilo de chat. */
export function PideAsesoria() {
  const { alertas, resolver } = useAlertas();
  const [seleccionada, setSeleccionada] = useState<string | null>(null);

  const conversaciones = alertas.filter((a) => a.tipo === 'solicita_asesor');
  const activa = conversaciones.find((c) => c.id === seleccionada) ?? null;

  // Si la seleccionada se resolvió (o no hay ninguna elegida todavía), autoseleccioná la primera.
  useEffect(() => {
    if (!conversaciones.find((c) => c.id === seleccionada)) {
      setSeleccionada(conversaciones[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversaciones.map((c) => c.id).join(',')]);

  return (
    <div>
      <div className="page-header">
        <h2>
          Pide Asesoría
          <span className="live-badge">
            <span className="live-dot" />
            en vivo
          </span>
        </h2>
        <p>{conversaciones.length} conversación{conversaciones.length !== 1 ? 'es' : ''} esperando</p>
      </div>

      <div className="asesoria-layout">
        <div className="asesoria-lista">
          {conversaciones.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-icon"><MessageCircle strokeWidth={1.5} /></div>
              <div className="empty-state-title">Sin pedidos de asesor</div>
              <div className="empty-state-text">Acá van a aparecer los clientes que pidan hablar con una persona</div>
            </div>
          )}
          {conversaciones.map((c) => (
            <button
              key={c.id}
              className={`asesoria-item ${c.id === seleccionada ? 'active' : ''}`}
              onClick={() => setSeleccionada(c.id)}
            >
              <div className="asesoria-item-phone">{c.referencia_id}</div>
              <div className="asesoria-item-msg">{c.mensaje}</div>
              <div className="asesoria-item-time">{new Date(c.creado_en).toLocaleString('es-AR')}</div>
            </button>
          ))}
        </div>

        <div className="asesoria-panel">
          {activa ? (
            <>
              <div className="asesoria-panel-header">
                <div className="asesoria-panel-phone">{activa.referencia_id}</div>
                <RoleGate roles={['admin', 'operador']}>
                  <button onClick={() => resolver(activa.id)} className="btn btn-success btn-sm">
                    <Check strokeWidth={2} /> Resuelta — el bot vuelve a responder
                  </button>
                </RoleGate>
              </div>
              <RoleGate roles={['admin', 'operador']}>
                <ChatAsesor telefono={activa.referencia_id} />
              </RoleGate>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon"><MessageCircle strokeWidth={1.5} /></div>
              <div className="empty-state-title">Elegí una conversación</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
