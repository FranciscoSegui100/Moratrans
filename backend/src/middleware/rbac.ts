import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { query } from '../config/db';
import { ACCESS_COOKIE } from '../services/session.service';

export type Rol = 'admin' | 'operador' | 'finanzas' | 'lectura';

export interface AuthUser {
  id: string;
  rol: Rol;
  email: string;
  tv: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Verifica el JWT (de la cookie httpOnly mt_at, nunca de un header: así un
 * XSS no puede leerlo con JS) y adjunta req.user. Además revalida contra la
 * base que el usuario siga activo y que el token no haya sido revocado
 * (token_version), para que desactivar/degradar a un usuario surta efecto al
 * instante y no recién cuando expire su access token (JWT_ACCESS_EXPIRES,
 * por defecto 8h — el frontend lo renueva solo vía /api/auth/refresh).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  let payload: AuthUser;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as AuthUser;
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  const rows = await query<{ activo: boolean; token_version: number }>(
    'SELECT activo, token_version FROM usuarios WHERE id = $1',
    [payload.id],
  );
  const usuario = rows[0];
  if (!usuario || !usuario.activo || usuario.token_version !== payload.tv) {
    return res.status(401).json({ error: 'Sesión inválida, iniciá sesión de nuevo' });
  }

  req.user = payload;
  next();
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
