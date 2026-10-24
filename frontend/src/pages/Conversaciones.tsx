import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Pause, Play, UserPlus, Search, Wallet, Clock, X } from 'lucide-react';
import { useConversaciones, Conversacion } from '../hooks/useConversaciones';
import { RoleGate } from '../components/RoleGate';
import { ChatAsesor } from '../components/ChatAsesor';
import { calcularVentana, formatVentana } from '../lib/ventanaWhatsapp';
import { useVentanaWhatsapp } from '../hooks/useVentanaWhatsapp';
import { useTiempoEspera } from '../hooks/useTiempoEspera';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import { formatearFecha } from '../lib/fechas';

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

interface ResumenChat {
  deuda: number;
  contenedor: { numero: string; vence_en: string | null } | null;
  pedidoPendiente: { zona: string; precio: string | null; cantidad: number } | null;
}

/**
 * Franja de contexto arriba del hilo de chat: deuda, contenedor/vencimiento
 * y pedido sin pagar del cliente activo, para que el asesor no tenga que
 * abrir otra pestaña a mitad de una conversación. El pedido pendiente suma
 * un botón de cancelar — el cliente no tiene esa opción en el bot a
 * propósito (ver messageRouter.ts), así que si queda trabado sin poder
 * pedir algo nuevo, la única salida es que el asesor lo destrabe desde acá.
 */
function ResumenCliente({ telefono }: { telefono: string }) {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [cancelando, setCancelando] = useState(false);
  const { data } = useQuery({
    queryKey: ['cliente-resumen-chat', telefono],
    queryFn: () => api.get<ResumenChat>(`/api/clientes/${encodeURIComponent(telefono)}/resumen-chat`).then((r) => r.data),
  });
  if (!data) return null;
  if (data.deuda <= 0 && !data.contenedor && !data.pedidoPendiente) return null;

  const vencido = data.contenedor?.vence_en ? new Date(data.contenedor.vence_en).getTime() < Date.now() : false;

  async function cancelarPedido() {
    if (!confirm('¿Cancelar el pedido pendiente de este cliente? Se le avisa por WhatsApp y queda libre para pedir algo nuevo.')) return;
    setCancelando(true);
    try {
      await api.post(`/api/chat/${encodeURIComponent(telefono)}/cancelar-pedido`);
      show('success', 'Pedido cancelado', 'Se le avisó al cliente por WhatsApp');
      queryClient.invalidateQueries({ queryKey: ['cliente-resumen-chat', telefono] });
    } catch (err: any) {
      show('error', 'No se pudo cancelar', err.response?.data?.error || 'Error desconocido');
    } finally {
      setCancelando(false);
    }
  }

  return (
    <div className="conv-resumen-cliente">
      {data.deuda > 0 && (
        <span className="conv-resumen-chip conv-resumen-chip--deuda">
          <Wallet size={13} strokeWidth={1.75} /> Debe ${data.deuda.toLocaleString('es-AR')}
        </span>
      )}
      {data.contenedor && (
        <span className={`conv-resumen-chip ${vencido ? 'conv-resumen-chip--vencido' : 'conv-resumen-chip--vence'}`}>
          <Clock size={13} strokeWidth={1.75} />
          Contenedor {data.contenedor.numero}
          {data.contenedor.vence_en && (vencido ? ` · venció el ${formatearFecha(data.contenedor.vence_en)}` : ` · vence el ${formatearFecha(data.contenedor.vence_en)}`)}
        </span>
      )}
      {data.pedidoPendiente && (
        <span className="conv-resumen-chip conv-resumen-chip--pendiente">
          📦 Pedido sin pagar: {data.pedidoPendiente.zona}
          {data.pedidoPendiente.precio && ` · $${Number(data.pedidoPendiente.precio).toLocaleString('es-AR')}`}
          {data.pedidoPendiente.cantidad > 1 && ` (+${data.pedidoPendiente.cantidad - 1} más)`}
          <RoleGate roles={['admin', 'operador']}>
            <button
              onClick={cancelarPedido}
              disabled={cancelando}
              className="conv-resumen-chip-cancelar"
              title="Cancelar este pedido"
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          </RoleGate>
        </span>
      )}
    </div>
  );
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
 * Quién es el otro lado de la charla: esta lista mezcla clientes Y choferes
 * (ambos le escriben al mismo bot), y entre los clientes hay comunes y de
 * cuenta corriente (no pagan por entrega — importa saberlo antes de
 * responder). Sin este chip no había forma de distinguirlos de un vistazo.
 */
function ChipTipoContacto({ c }: { c: Conversacion }) {
  if (c.chofer_nombre) return <span className="chip chip--chofer">🚚 Chofer</span>;
  if (c.cuenta_corriente_estado === 'aprobada') return <span className="chip chip--cc">Cuenta corriente</span>;
  return <span className="chip chip--comun">Cliente común</span>;
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
}: {
  c: Conversacion;
  activo: boolean;
  onSelect: () => void;
}) {
  const espera = useTiempoEspera(c.escalado_en ?? c.asignado_en);
  // El chat abierto ya se está leyendo: no se marca como no leído aunque el
  // número tarde un instante en volver a 0.
  const noLeido = c.no_leidos > 0 && !activo;
  return (
    <div
      className={`asesoria-item ${activo ? 'active' : ''} ${c.modo_humano ? 'asesoria-item--alerta' : ''} ${noLeido ? 'asesoria-item--no-leido' : ''}`}
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
        <div className="asesoria-item-lado">
          <span className="asesoria-item-time">{formatHora(c.ultimo_en)}</span>
          {noLeido && (
            <span className="asesoria-item-noleidos" aria-label={`${c.no_leidos} mensaje(s) sin leer`}>
              {c.no_leidos >= 99 ? '99+' : c.no_leidos}
            </span>
          )}
        </div>
      </div>
      <p className="asesoria-item-msg">
        {origenPreviewPrefix[c.ultimo_origen]}{c.ultimo_mensaje}
      </p>
      <div className="asesoria-item-pie">
        <ChipTipoContacto c={c} />
        <ChipEstado c={c} />
        {c.modo_humano && espera.minutos !== null && (
          <span className={`sla-chip sla-chip--${espera.nivel}`}>
            {c.escalado_en ? 'Esperando ' : 'Atendiendo '}{espera.texto}
          </span>
        )}
        {c.asignado_a_nombre && <span className="asesoria-item-asignado">👤 {c.asignado_a_nombre}</span>}
      </div>
    </div>
  );
}

/** Vista general: TODAS las conversaciones del bot (no solo las que piden asesor), con hilo completo y pausa manual. */
export function Conversaciones() {
  const { conversaciones, setModoHumano, reclamar, marcarLeido } = useConversaciones();
  const { user } = useAuth();
  const { show } = useToast();
  // Deep-link desde la Bandeja de alertas (ver rutaAlerta en Alertas.tsx):
  // /conversaciones?tel=5492611234567 abre directo ese chat.
  const [searchParams] = useSearchParams();
  const [seleccionado, setSeleccionado] = useState<string | null>(() => searchParams.get('tel'));
  const [filtro, setFiltro] = useState<'todas' | 'requieren'>('todas');
  // Separa choferes de clientes (cuenta corriente + comunes) en la lista —
  // comparten el mismo bot y antes quedaban mezclados, solo diferenciados
  // por el chip chico de ChipTipoContacto.
  const [tipoContacto, setTipoContacto] = useState<'todos' | 'clientes' | 'choferes'>('todos');
  const [busqueda, setBusqueda] = useState('');
  // Fuerza un re-render por minuto para que los chips de "ventana cerrada" de
  // la lista se actualicen solos aunque no llegue ningún mensaje nuevo.
  const [, forzarTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => forzarTick((n) => n + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  const activa = conversaciones.find((c) => c.telefono === seleccionado) ?? null;

  // El chat abierto queda leído (para este usuario) al abrirlo y cada vez que
  // le llega un mensaje nuevo mientras está abierto — pero solo si la pestaña
  // está a la vista: con el panel en otra pestaña del navegador, lo que llega
  // sigue contando como no leído hasta que vuelva.
  const telefonoActivo = activa?.telefono ?? null;
  const noLeidosActivo = activa?.no_leidos ?? 0;
  useEffect(() => {
    if (!telefonoActivo) return;
    const marcarSiVisible = () => {
      if (document.visibilityState === 'visible' && noLeidosActivo > 0) marcarLeido(telefonoActivo);
    };
    marcarSiVisible();
    document.addEventListener('visibilitychange', marcarSiVisible);
    return () => document.removeEventListener('visibilitychange', marcarSiVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telefonoActivo, noLeidosActivo]);
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
  // Una conversación que pide asesor se MUEVE a "Necesitan asesor": deja de
  // aparecer en "Todas" hasta que se resuelva o se libere (modo_humano false).
  const sinAsesor = conversaciones.filter((c) => !c.modo_humano);
  const visiblesPorFiltro = filtro === 'requieren' ? requierenVosOrdenadas : sinAsesor;
  const cantChoferes = visiblesPorFiltro.filter((c) => !!c.chofer_nombre).length;
  const cantClientes = visiblesPorFiltro.length - cantChoferes;
  const visiblesPorTipo =
    tipoContacto === 'choferes' ? visiblesPorFiltro.filter((c) => !!c.chofer_nombre)
    : tipoContacto === 'clientes' ? visiblesPorFiltro.filter((c) => !c.chofer_nombre)
    : visiblesPorFiltro;
  const visibles = busqueda.trim()
    ? visiblesPorTipo.filter((c) => {
        const q = busqueda.trim().toLowerCase();
        return c.telefono.includes(q) || (c.nombre?.toLowerCase().includes(q) ?? false);
      })
    : visiblesPorTipo;

  async function manejarReclamar() {
    if (!activa) return;
    try {
      await reclamar(activa.telefono);
    } catch (err: any) {
      show('error', 'No se pudo reclamar', err.response?.data?.error || 'Error desconocido');
    }
  }

  /** Para un chat que quedó "atendido por" alguien que ya no está con el panel abierto: te la reasigna de todas formas. */
  async function manejarTomarDeTodasFormas() {
    if (!activa) return;
    if (!confirm(`${activa.asignado_a_nombre ?? 'Otro operador'} tiene esta conversación asignada. ¿Tomarla de todas formas?`)) return;
    try {
      await reclamar(activa.telefono, true);
    } catch (err: any) {
      show('error', 'No se pudo tomar la conversación', err.response?.data?.error || 'Error desconocido');
    }
  }

  /** Devuelve el chat al bot aunque esté asignado a otro operador — mismo caso de destrabe. */
  async function manejarReactivarBotDeTodasFormas() {
    if (!activa) return;
    if (!confirm(`${activa.asignado_a_nombre ?? 'Otro operador'} tiene esta conversación asignada. ¿Reactivar el bot de todas formas?`)) return;
    try {
      await setModoHumano(activa.telefono, false);
    } catch (err: any) {
      show('error', 'No se pudo reactivar el bot', err.response?.data?.error || 'Error desconocido');
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
    <div className="conv-pagina">
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
          <div className="conv-busqueda">
            <Search size={14} className="conv-busqueda-icon" />
            <input
              className="form-input"
              placeholder="Buscar por nombre o teléfono..."
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
          </div>

          <div className="conv-filtros">
            <button
              className={`conv-filtro ${filtro === 'todas' ? 'active' : ''}`}
              onClick={() => setFiltro('todas')}
            >
              Todas <b>{sinAsesor.length}</b>
            </button>
            <button
              className={`conv-filtro conv-filtro--alerta ${filtro === 'requieren' ? 'active' : ''}`}
              onClick={() => setFiltro('requieren')}
            >
              {requierenVos.length > 0 && <span className="conv-filtro-dot" />}
              Necesitan asesor <b>{requierenVos.length}</b>
            </button>
          </div>

          <div className="conv-filtros conv-filtros--tipo">
            <button
              className={`conv-filtro ${tipoContacto === 'todos' ? 'active' : ''}`}
              onClick={() => setTipoContacto('todos')}
            >
              Todos <b>{visiblesPorFiltro.length}</b>
            </button>
            <button
              className={`conv-filtro ${tipoContacto === 'clientes' ? 'active' : ''}`}
              onClick={() => setTipoContacto('clientes')}
            >
              👤 Clientes <b>{cantClientes}</b>
            </button>
            <button
              className={`conv-filtro ${tipoContacto === 'choferes' ? 'active' : ''}`}
              onClick={() => setTipoContacto('choferes')}
            >
              🚚 Choferes <b>{cantChoferes}</b>
            </button>
          </div>

          <div className="asesoria-lista">
            {visibles.length === 0 && (
              <div className="empty-state">
                <div className="empty-state-icon"><MessageCircle strokeWidth={1.5} /></div>
                <div className="empty-state-title">
                  {tipoContacto === 'choferes' ? 'Ningún chofer por acá'
                    : tipoContacto === 'clientes' ? 'Ningún cliente por acá'
                    : filtro === 'requieren' ? 'Nadie te está esperando' : 'Sin conversaciones todavía'}
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
                    <div className="asesoria-panel-nombre" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {activa.nombre ?? activa.telefono}
                      <ChipTipoContacto c={activa} />
                    </div>
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
                    <div className="asesoria-atendida-por-bloque">
                      <span className="asesoria-atendida-por">Atendida por {activa.asignado_a_nombre}</span>
                      <button onClick={manejarTomarDeTodasFormas} className="btn btn-ghost btn-sm" title="Por si el otro operador no está disponible">
                        <UserPlus strokeWidth={2} /> Tomar de todas formas
                      </button>
                      <button onClick={manejarReactivarBotDeTodasFormas} className="btn btn-ghost btn-sm" title="Por si el otro operador no está disponible">
                        <Play strokeWidth={2} /> Reactivar bot de todas formas
                      </button>
                    </div>
                  )}
                </RoleGate>
              </div>

              <ResumenCliente telefono={activa.telefono} />

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
              </div>

              <RoleGate roles={['admin', 'operador']}>
                <ChatAsesor telefono={activa.telefono} ventanaCerrada={ventanaActiva.cerrada} modoHumano={activa.modo_humano} />
              </RoleGate>
            </>
          ) : seleccionado ? (
            <div className="empty-state">
              <div className="empty-state-icon"><MessageCircle strokeWidth={1.5} /></div>
              <div className="empty-state-title">Este cliente todavía no te escribió</div>
              <div className="empty-state-text">
                {seleccionado} no tiene conversación con el bot — por ahora no se le puede mandar texto libre por WhatsApp,
                solo responder si él escribe primero.
              </div>
            </div>
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
