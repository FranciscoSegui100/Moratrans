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
      // La causa más común: la cookie de sesión (dura 15 min) venció mientras
      // el socket estaba desconectado (redeploy, corte de red, la compu se
      // suspendió) y nadie la renovó mientras tanto — sin esto, reintentaba
      // solo con la cookie vieja para siempre y nunca volvía a conectar.
      // socket.io reintenta la conexión solo (reconection: true por defecto);
      // alcanza con dejar la cookie fresca antes de su próximo intento.
      intentarRefresh();
    });
    socket.on('disconnect', (motivo) => console.warn('[socket] disconnect:', motivo));

    // El navegador puede meter la pestaña en el back-forward cache (bfcache)
    // y ahí mismo corta el WebSocket ("Page entered Back-Forward Cache") —
    // y mientras la pestaña está congelada, TODO el JS se pausa, incluidos
    // los timers de reintento de socket.io. Al restaurarse (pageshow con
    // persisted=true) el reintento automático puede quedar colgado, así que
    // forzamos la reconexión a mano en cuanto la pestaña vuelve a estar viva.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && socket && !socket.connected) {
        intentarRefresh();
        socket.connect();
      }
    });
    // Red de seguridad general: cualquier otra causa por la que la pestaña
    // haya quedado con el socket caído (no solo bfcache) se corrige apenas
    // el operador vuelve a mirarla, en vez de esperar a que note el badge
    // "Sin conexión en vivo" y recargue a mano.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && socket && !socket.connected) {
        intentarRefresh();
        socket.connect();
      }
    });
  } else if (!socket.connected) {
    socket.connect();
  }
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}
