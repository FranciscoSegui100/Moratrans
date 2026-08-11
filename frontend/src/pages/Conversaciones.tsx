import { useEffect, useState } from 'react';
import { MessageCircle, Pause, Play } from 'lucide-react';
import { useConversaciones, Conversacion } from '../hooks/useConversaciones';
import { RoleGate } from '../components/RoleGate';
import { ChatAsesor } from '../components/ChatAsesor';
import { calcularVentana, formatVentana } from '../lib/ventanaWhatsapp';
import { useVentanaWhatsapp } from '../hooks/useVentanaWhatsapp';

const origenPreviewPrefix: Record<string, string> = {
  cliente: '',
  bot: '🤖 ',
  operador: '🙋 ',
};

function iniciales(nombre: string | null, telefono: string): string {
  if (nombre) {
    const partes = nombre.trim().split(/\s+/);
    return (partes[0][0] + (partes[1]?.[0] ?? '')).toUpperCase();
  }
  return telefono.slice(-2);
}

function formatHora(iso: string): string {
  const fecha = new Date(iso);
  const hoy = new Date();
  const mismoDia = fecha.toDateString() === hoy.toDateString();
  if (mismoDia) return fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);
  if (fecha.toDateString() === ayer.toDateString()) return 'Ayer';
  return fecha.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

function ChipEstado({ c }: { c: Conversacion }) {
  const ventana = calcularVentana(c.ultimo_cliente_en);
  if (ventana.cerrada) return <span className="chip chip--cerrada">Ventana cerrada</span>;
  if (c.modo_humano) return <span className="chip chip--espera">Requiere vos</span>;
  return <span className="chip chip--bot">Bot</span>;
}

/** Vista general: TODAS las conversaciones del bot (no solo las que piden asesor), con hilo completo y pausa manual. */
export function Conversaciones() {
  const { conversaciones, setModoHumano } = useConversaciones();
  const [seleccionado, setSeleccionado] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<'todas' | 'requieren'>('todas');
  // Fuerza un re-render por minuto para que los chips de "ventana cerrada" de
  // la lista se actualicen solos aunque no llegue ningún mensaje nuevo.
  const [, forzarTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => forzarTick((n) => n + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  const activa = conversaciones.find((c) => c.telefono === seleccionado) ?? null;
  const ventanaActiva = useVentanaWhatsapp(activa?.ultimo_cliente_en ?? null);

  const requierenVos = conversaciones.filter((c) => c.modo_humano);
  const visibles = filtro === 'requieren' ? requierenVos : conversaciones;

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
        <div className="asesoria-lista-col">
          <div className="conv-filtros">
            <button
              className={`conv-filtro ${filtro === 'todas' ? 'active' : ''}`}
              onClick={() => setFiltro('todas')}
            >
              Todas <b>{conversaciones.length}</b>
            </button>
            <button
              className={`conv-filtro ${filtro === 'requieren' ? 'active' : ''}`}
              onClick={() => setFiltro('requieren')}
            >
              Requieren vos <b>{requierenVos.length}</b>
            </button>
          </div>

          <div className="asesoria-lista">
            {visibles.length === 0 && (
              <div className="empty-state">
                <div className="empty-state-icon"><MessageCircle strokeWidth={1.5} /></div>
                <div className="empty-state-title">
                  {filtro === 'requieren' ? 'Nadie te está esperando' : 'Sin conversaciones todavía'}
                </div>
                <div className="empty-state-text">
                  {filtro === 'requieren'
                    ? 'Cuando un cliente pida un asesor o tomes vos una charla, va a aparecer acá'
                    : 'Acá van a aparecer todos los clientes que le escriban al bot'}
                </div>
              </div>
            )}
            {visibles.map((c) => (
              <button
                key={c.telefono}
                className={`asesoria-item ${c.telefono === seleccionado ? 'active' : ''}`}
                onClick={() => setSeleccionado(c.telefono)}
              >
                <div className="asesoria-item-top">
                  <span className="asesoria-avatar">{iniciales(c.nombre, c.telefono)}</span>
                  <div className="asesoria-item-quien">
                    <div className="asesoria-item-nombre">{c.nombre ?? c.telefono}</div>
                    {c.nombre && <div className="asesoria-item-tel">{c.telefono}</div>}
                  </div>
                  <span className="asesoria-item-time">{formatHora(c.ultimo_en)}</span>
                </div>
                <p className="asesoria-item-msg">
                  {origenPreviewPrefix[c.ultimo_origen]}{c.ultimo_mensaje}
                </p>
                <div className="asesoria-item-pie">
                  <ChipEstado c={c} />
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="asesoria-panel">
          {activa ? (
            <>
              <div className="asesoria-panel-header">
                <div className="asesoria-panel-quien">
                  <span className="asesoria-avatar asesoria-avatar-lg">{iniciales(activa.nombre, activa.telefono)}</span>
                  <div>
                    <div className="asesoria-panel-nombre">{activa.nombre ?? activa.telefono}</div>
                    {activa.nombre && <div className="asesoria-panel-tel">{activa.telefono}</div>}
                  </div>
                </div>
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

              <div className="ventana">
                <div className="ventana-fila">
                  <span className="rotulo">Ventana de respuesta</span>
                  <span className={`ventana-resta ${ventanaActiva.cerrada ? 'cerrada' : ''}`}>
                    {formatVentana(ventanaActiva)}
                  </span>
                </div>
                <div className="ventana-barra">
                  <span style={{ width: `${ventanaActiva.porcentaje}%` }} />
                </div>
              </div>

              <RoleGate roles={['admin', 'operador']}>
                <ChatAsesor telefono={activa.telefono} ventanaCerrada={ventanaActiva.cerrada} />
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
