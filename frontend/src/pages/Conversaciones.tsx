import { useEffect, useState } from 'react';
import { MessageCircle, Pause, Play } from 'lucide-react';
import { useConversaciones } from '../hooks/useConversaciones';
import { RoleGate } from '../components/RoleGate';
import { ChatAsesor } from '../components/ChatAsesor';

const origenPreviewPrefix: Record<string, string> = {
  cliente: '',
  bot: '🤖 ',
  operador: '🙋 ',
};

/** Vista general: TODAS las conversaciones del bot (no solo las que piden asesor), con hilo completo y pausa manual. */
export function Conversaciones() {
  const { conversaciones, setModoHumano } = useConversaciones();
  const [seleccionado, setSeleccionado] = useState<string | null>(null);

  const activa = conversaciones.find((c) => c.telefono === seleccionado) ?? null;

  // Si la seleccionada ya no está en la lista (o no hay ninguna elegida todavía), autoseleccioná la primera.
  useEffect(() => {
    if (!conversaciones.find((c) => c.telefono === seleccionado)) {
      setSeleccionado(conversaciones[0]?.telefono ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversaciones.map((c) => c.telefono).join(',')]);

  return (
    <div>
      <div className="page-header">
        <h2>
          Conversaciones
          <span className="live-badge">
            <span className="live-dot" />
            en vivo
          </span>
        </h2>
        <p>{conversaciones.length} conversación{conversaciones.length !== 1 ? 'es' : ''}</p>
      </div>

      <div className="asesoria-layout">
        <div className="asesoria-lista">
          {conversaciones.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-icon"><MessageCircle strokeWidth={1.5} /></div>
              <div className="empty-state-title">Sin conversaciones todavía</div>
              <div className="empty-state-text">Acá van a aparecer todos los clientes que le escriban al bot</div>
            </div>
          )}
          {conversaciones.map((c) => (
            <button
              key={c.telefono}
              className={`asesoria-item ${c.telefono === seleccionado ? 'active' : ''}`}
              onClick={() => setSeleccionado(c.telefono)}
            >
              <div className="asesoria-item-phone">
                {c.telefono}
                {c.modo_humano && (
                  <span style={{ marginLeft: 6, fontSize: '0.68rem', color: 'var(--accent)' }}>⏸ pausado</span>
                )}
              </div>
              <div className="asesoria-item-msg">
                {origenPreviewPrefix[c.ultimo_origen]}{c.ultimo_mensaje}
              </div>
              <div className="asesoria-item-time">{new Date(c.ultimo_en).toLocaleString('es-AR')}</div>
            </button>
          ))}
        </div>

        <div className="asesoria-panel">
          {activa ? (
            <>
              <div className="asesoria-panel-header">
                <div className="asesoria-panel-phone">{activa.telefono}</div>
                <RoleGate roles={['admin', 'operador']}>
                  {activa.modo_humano ? (
                    <button onClick={() => setModoHumano(activa.telefono, false)} className="btn btn-success btn-sm">
                      <Play strokeWidth={2} /> Reanudar bot
                    </button>
                  ) : (
                    <button onClick={() => setModoHumano(activa.telefono, true)} className="btn btn-danger btn-sm">
                      <Pause strokeWidth={2} /> Pausar bot y responder yo
                    </button>
                  )}
                </RoleGate>
              </div>
              <RoleGate roles={['admin', 'operador']}>
                <ChatAsesor telefono={activa.telefono} />
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
