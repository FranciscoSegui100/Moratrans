import { Request, Response, NextFunction } from 'express';
import { CSRF_COOKIE } from '../services/session.service';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Doble-cookie CSRF: obligatorio porque las cookies de sesión usan
 * SameSite=None en producción (frontend y backend viven en dominios
 * distintos, así que SameSite por sí solo no alcanza para bloquear un POST
 * cross-site). El frontend copia el valor de la cookie `mt_csrf` (no
 * httpOnly, por eso JS puede leerla) al header `X-CSRF-Token`; un sitio
 * externo no puede leer esa cookie por same-origin policy, así que no puede
 * reproducir el header.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (METODOS_SEGUROS.has(req.method)) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.header('x-csrf-token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Token CSRF inválido o ausente' });
  }
  next();
}
