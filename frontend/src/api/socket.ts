import { io, Socket } from 'socket.io-client';

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
    socket.on('connect_error', (err) => console.error('[socket] connect_error:', err.message));
    socket.on('disconnect', (motivo) => console.warn('[socket] disconnect:', motivo));
  } else if (!socket.connected) {
    socket.connect();
  }
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}
