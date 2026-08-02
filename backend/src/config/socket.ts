import { Server as HttpServer } from 'http';
import { Server as IOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from './env';

let io: IOServer | null = null;

// Inicializa Socket.io sobre el mismo servidor HTTP de Express.
export function initSocket(server: HttpServer): IOServer {
  io = new IOServer(server, { cors: { origin: env.CORS_ORIGIN, credentials: true } });

  // Autenticación del socket con el mismo JWT del panel.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
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

export function getIO(): IOServer {
  if (!io) throw new Error('Socket.io no inicializado');
  return io;
}
