import { Server as HttpServer } from 'http';
import { Server as IOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import { env } from './env';
import { ACCESS_COOKIE } from '../services/session.service';

let io: IOServer | null = null;

// Inicializa Socket.io sobre el mismo servidor HTTP de Express.
export function initSocket(server: HttpServer): IOServer {
  io = new IOServer(server, {
    cors: { origin: env.CORS_ORIGIN, credentials: true },
  });

  // Autenticación del socket con el access token del panel: ya no viaja en
  // `auth.token` del handshake (el JWT dejó de ser accesible por JS), se lee
  // de la misma cookie httpOnly mt_at que usa el resto de la API. El browser
  // la adjunta solo si la conexión se abre con `withCredentials`.
  io.use((socket, next) => {
    const crudo = socket.handshake.headers.cookie;
    const token = crudo ? cookie.parse(crudo)[ACCESS_COOKIE] : undefined;
    if (!token) return next(new Error('no token'));
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as { id: string; rol: string };
      (socket.data as any).user = payload;
      // Operadores/admin entran a la sala de alertas
      if (['admin', 'operador', 'finanzas'].includes(payload.rol)) socket.join('alertas');
      next();
    } catch {
      next(new Error('token inválido'));
    }
  });

  return io;
}

// Emite un evento a la sala de alertas (usado por el cron y por eventos de negocio).
export function emitAlerta(payload: unknown): void {
  io?.to('alertas').emit('nueva_alerta', payload);
}

// Empuja un mensaje nuevo del hilo de chat (cliente/bot/operador) a los
// operadores conectados, para que el chat de "Pide Asesoría" se actualice
// solo en vez de depender del polling cada 5s.
export function emitMensajeChat(payload: unknown): void {
  io?.to('alertas').emit('nuevo_mensaje_chat', payload);
}

/**
 * Avisa que una alerta cambió de estado (resuelta, vista, etc.) a TODOS los
 * operadores conectados, no solo al que hizo la acción. Sin esto, cuando un
 * operador resuelve una alerta / valida o rechaza un pago / confirma un
 * retiro, el resto solo lo ve reflejado tras un F5 manual — cada acción solo
 * actualizaba el caché local de quien la disparó.
 */
export function emitAlertaActualizada(payload: { tipo: string; referencia_id: string; estado: string }): void {
  io?.to('alertas').emit('alerta_actualizada', payload);
}

/** Avisa que se pausó/reanudó el bot para un teléfono, para que la lista de "Conversaciones" se actualice en todos los operadores conectados. */
export function emitConversacionActualizada(payload: { telefono: string; modo_humano: boolean }): void {
  io?.to('alertas').emit('conversacion_actualizada', payload);
}

/**
 * Evento genérico: "algo cambió bajo /api/<recurso>". Lo dispara el
 * middleware `broadcastCambios` después de cualquier POST/PATCH/PUT/DELETE
 * exitoso, para que TODAS las pantallas del panel (contenedores, choferes,
 * viajes, tarifas, usuarios...) se refresquen solas en cualquier operador
 * conectado, sin tener que instrumentar cada endpoint a mano.
 */
export function emitRecursoActualizado(recurso: string): void {
  io?.to('alertas').emit('recurso_actualizado', { recurso });
}

export function getIO(): IOServer {
  if (!io) throw new Error('Socket.io no inicializado');
  return io;
}
