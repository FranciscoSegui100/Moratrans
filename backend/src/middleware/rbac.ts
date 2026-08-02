import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export type Rol = 'admin' | 'operador' | 'finanzas' | 'lectura';

export interface AuthUser {
  id: string;
  rol: Rol;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Verifica el JWT y adjunta req.user. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

/** Restringe una ruta a ciertos roles. */
export function requireRol(...roles: Rol[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'Permiso insuficiente' });
    }
    next();
  };
}

/**
 * Reglas de visibilidad de datos sensibles según rol.
 * - DNI de choferes: sólo admin y operador.
 * - Comprobantes de pago (url_comprobante): admin y finanzas.
 */
export const puedeVerDni = (rol: Rol) => rol === 'admin' || rol === 'operador';
export const puedeVerComprobante = (rol: Rol) => rol === 'admin' || rol === 'finanzas';

/** Enmascara campos sensibles de un objeto según el rol del usuario. */
export function filtrarSensibles<T extends Record<string, any>>(obj: T, rol: Rol): T {
  const clon: any = { ...obj };
  if ('dni' in clon && !puedeVerDni(rol)) clon.dni = '••••••';
  if ('url_comprobante' in clon && !puedeVerComprobante(rol)) clon.url_comprobante = null;
  return clon;
}
