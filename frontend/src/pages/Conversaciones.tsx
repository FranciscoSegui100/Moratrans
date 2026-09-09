import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageCircle, Pause, Play, UserPlus } from 'lucide-react';
import { useConversaciones, Conversacion } from '../hooks/useConversaciones';
import { RoleGate } from '../components/RoleGate';
import { ChatAsesor } from '../components/ChatAsesor';
import { calcularVentana, formatVentana } from '../lib/ventanaWhatsapp';
import { useVentanaWhatsapp } from '../hooks/useVentanaWhatsapp';
import { useTiempoEspera } from '../hooks/useTiempoEspera';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

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
  // Modo humano ya lo marca el resaltado rojo de la fila + el chip de SLA
  // ("esperando hace X") — este chip de texto quedaba redundante con esos dos.
  if (c.modo_humano) return null;
  return <span className="chip chip--bot">Bot</span>;
}

/**
 * Fila de la lista, como componente aparte (no inline en el .map de
 * Conversaciones) porque necesita su propio useTiempoEspera — llamar un hook
 * dentro de un .map() del padre violaría las reglas de hooks apenas la
 * cantidad de filas cambiara entre renders.
 */
function ConversacionItem({
  c,
  activo,
  onSelect,
  onResponderAhora,
}: {
  c: Conversacion;
  activo: boolean;
  onSelect: () => void;
  onResponderAhora: () => void;
}) {
  const espera = useTiempoEspera(c.escalado_en ?? c.asignado_en);
  return (
    <div
      className={`asesoria-item ${activo ? 'active' : ''} ${c.modo_humano ? 'asesoria-item--alerta' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
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
        {c.modo_humano && espera.minutos !== null && (
          <span className={`sla-chip sla-chip--${espera.nivel}`}>
            {c.escalado_en ? 'Esperando ' : 'Atendiendo '}{espera.texto}
          </span>
        )}
        {c.asignado_a_nombre && <span className="asesoria-item-asignado">👤 {c.asignado_a_nombre}</span>}
        {!c.modo_humano && (
          <button
            className="btn-responder-ahora"
            onClick={(e) => { e.stopPropagation(); onResponderAhora(); }}
          >
            Responder ahora
          </button>
        )}
      </div>
    </div>
  );
}

/** Vista general: TODAS las conversaciones del bot (no solo las que piden asesor), con hilo completo y pausa manual. */
export function Conversaciones() {
  const { conversaciones, setModoHumano, reclamar } = useConversaciones();
  const { user } = useAuth();
  const { show } = useToast();
  // Deep-link desde la Bandeja de alertas (ver rutaAlerta en Alertas.tsx):
  // /conversaciones?tel=5492611234567 abre directo ese chat.
  const [searchParams] = useSearchParams();
  const [seleccionado, setSeleccionado] = useState<string | null>(() => searchParams.get('tel'));
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
  // Más vieja primero: la que lleva más tiempo esperando no se puede tapar
  // con una que acaba de entrar. escalado_en (el bot pidió asesor) manda
  // sobre asignado_en (un operador la tomó a mano sin escalación).
  const requierenVosOrdenadas = [...requierenVos].sort((a, b) => {
    const ta = new Date(a.escalado_en ?? a.asignado_en ?? a.ultimo_en).getTime();
    const tb = new Date(b.escalado_en ?? b.asignado_en ?? b.ultimo_en).getTime();
    return ta - tb;
  });
  const visibles = filtro === 'requieren' ? requierenVosOrdenadas : conversaciones;

  // Si la seleccionada ya no está en la lista (o no hay ninguna elegida todavía), autoseleccioná la primera.
  // El guard de largo > 0 evita pisar el ?tel= del deep-link mientras la
  // lista todavía está cargando (conversaciones = [] antes de que responda la API).
  useEffect(() => {
    if (conversaciones.length > 0 && !conversaciones.find((c) => c.telefono === seleccionado)) {
      setSeleccionado(conversaciones[0]?.telefono ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversaciones.map((c) => c.telefono).join(',')]);

  async function responderAhora(telefono: string) {
    setSeleccionado(telefono);
    try {
      await setModoHumano(telefono, true);
    } catch (err: any) {
      show('error', 'No se pudo tomar la conversación', err.response?.data?.error || 'Error desconocido');
    }
  }

  async function manejarReclamar() {
    if (!activa) return;
    try {
      await reclamar(activa.telefono);
    } catch (err: any) {
      show('error', 'No se pudo reclamar', err.response?.data?.error || 'Error desconocido');
    }
  }

  async function manejarPausar() {
    if (!activa) return;
    try {
      await setModoHumano(activa.telefono, true);
    } catch (err: any) {
      show('error', 'No se pudo tomar la conversación', err.response?.data?.error || 'Error desconocido');
    }
  }

  async function manejarResolver() {
    if (!activa) return;
    try {
      await setModoHumano(activa.telefono, false);
    } catch (err: any) {
      show('error', 'No se pudo resolver', err.response?.data?.error || 'Error desconocido');
    }
  }

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
              className={`conv-filtro conv-filtro--alerta ${filtro === 'requieren' ? 'active' : ''}`}
              onClick={() => setFiltro('requieren')}
            >
              {requierenVos.length > 0 && <span className="conv-filtro-dot" />}
              Necesitan asesor <b>{requierenVos.length}</b>
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
              <ConversacionItem
                key={c.telefono}
                c={c}
                activo={c.telefono === seleccionado}
                onSelect={() => setSeleccionado(c.telefono)}
                onResponderAhora={() => responderAhora(c.telefono)}
              />
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
                  {!activa.modo_humano && (
                    <button onClick={manejarPausar} className="btn btn-danger btn-sm">
                      <Pause strokeWidth={2} /> Pausar bot y responder yo
                    </button>
                  )}
                  {activa.modo_humano && !activa.asignado_a && (
                    <button onClick={manejarReclamar} className="btn btn-danger btn-sm">
                      <UserPlus strokeWidth={2} /> Reclamar
                    </button>
                  )}
                  {activa.modo_humano && activa.asignado_a === user?.id && (
                    <button onClick={manejarResolver} className="btn btn-success btn-sm">
                      <Play strokeWidth={2} /> Resuelto, reactivar bot
                    </button>
                  )}
                  {activa.modo_humano && activa.asignado_a && activa.asignado_a !== user?.id && (
                    <span className="asesoria-atendida-por">Atendida por {activa.asignado_a_nombre}</span>
                  )}
                </RoleGate>
              </div>

              {activa.motivo && (
                <div className="asesoria-motivo">
                  🙋 <b>Motivo:</b> {activa.motivo}
                </div>
              )}

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
