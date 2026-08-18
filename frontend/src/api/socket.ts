import { io, Socket } from 'socket.io-client';
import { intentarRefresh } from './client';

const API_URL = import.meta.env.VITE_API_URL || '';
let socket: Socket | null = null;

/**
 * Devuelve el socket compartido de la app (autenticado con la cookie httpOnly
 * mt_at del panel — withCredentials hace que el browser la mande sola en el
 * handshake, ver backend/src/config/socket.ts), conectándolo si hace falta.
 * Varios componentes lo piden (Layout para el badge, useAlertas para el
 * listado): si se recreara en cada llamada, como antes, cada nueva conexión
 * mataba la anterior y dejaba "colgados" los listeners ya registrados en ella
 * (el badge del sidebar dejaba de recibir alertas apenas se entraba una vez a
 * la página de Alertas).
 */
export function conectarSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, { withCredentials: true });
    // Diagnóstico: sin esto, si el handshake falla (cookie, CORS, proxy) queda
    // en silencio y el panel solo parece "andar" tras recargar (REST sí trae
    // los datos, pero nunca llegan los eventos en vivo).
    socket.on('connect_error', (err) => {
      console.error('[socket] connect_error:', err.message);
      // La causa más común: la cookie de sesión (dura JWT_ACCESS_EXPIRES, 8h) venció mientras
      // el socket estaba desconectado (redeploy, corte de red, la compu se
      // suspendió) y nadie la renovó mientras tanto — sin esto, reintentaba
      // solo con la cookie vieja para siempre y nunca volvía a conectar.
      // socket.io reintenta la conexión solo (reconection: true por defecto);
      // alcanza con dejar la cookie fresca antes de su próximo intento.
      intentarRefresh();
    });
    socket.on('disconnect', (motivo) => console.warn('[socket] disconnect:', motivo));
    // Confirma en la consola que la reconexión (manual o automática) anduvo,
    // para no tener que inferirlo por si llegó o no una alerta.
    socket.on('connect', () => console.info('[socket] conectado:', socket!.id));

    // El navegador puede meter la pestaña en el back-forward cache (bfcache)
    // y ahí mismo corta el WebSocket ("Page entered Back-Forward Cache") —
    // socket.io ya reintenta conectar solo después (reconnection: true por
    // defecto, para siempre, con backoff), así que NO hay que forzar
    // `socket.connect()` a mano: llamarlo mientras ya hay un intento
    // automático en curso los hace pisarse entre sí ("WebSocket is closed
    // before the connection is established"). Lo único que puede hacer
    // fallar ese reintento automático es una cookie de sesión vencida — eso
    // sí lo renovamos apenas la pestaña vuelve a estar visible, para que el
    // próximo intento automático (no uno nuestro) tenga con qué autenticarse.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) intentarRefresh();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && socket && !socket.connected) {
        intentarRefresh();
      }
    });
  }
  // No se llama socket.connect() a mano en el path de reuso: socket.io ya
  // reintenta conectar solo (reconnection: true por defecto), y forzarlo acá
  // puede pisarse con un handshake que ya está en curso (mismo riesgo que el
  // comentario de más arriba sobre pageshow/bfcache) — de eso salían las
  // notificaciones intermitentes cuando los tres useEffect de Layout.tsx
  // pedían el socket en el mismo ciclo de montaje.
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}
