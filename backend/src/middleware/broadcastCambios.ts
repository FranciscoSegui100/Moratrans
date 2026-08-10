import { Request, Response, NextFunction } from 'express';
import { emitRecursoActualizado } from '../config/socket';

const METODOS_MUTANTES = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Después de cualquier request que modifica datos bajo /api/<recurso>/...,
 * avisa por socket a todos los operadores conectados para que esa pantalla
 * se refresque sola (sin F5) en cualquier otra sesión abierta — sin tener
 * que instrumentar cada endpoint del panel a mano. Montado en `/api`, así
 * que corre para cualquier router excepto auth (que responde antes de llegar
 * acá, ver app.ts).
 */
export function broadcastCambios(req: Request, res: Response, next: NextFunction) {
  if (!METODOS_MUTANTES.has(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    // req.path es relativo al mount point ('/api'): '/contenedores/123/x' -> 'contenedores'.
    const recurso = req.path.split('/')[1];
    if (recurso) emitRecursoActualizado(recurso);
  });
  next();
}
