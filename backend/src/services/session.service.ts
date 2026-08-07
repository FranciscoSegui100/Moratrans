import crypto from 'crypto';
import { Request, Response } from 'express';
import { query } from '../config/db';
import { env, isProd } from '../config/env';

/**
 * Sesiones del panel: access token corto (JWT, cookie httpOnly) + refresh
 * token opaco de larga duración (cookie httpOnly, guardado hasheado en la
 * tabla `sesiones`, rotado en cada uso). Nunca en localStorage: así un XSS en
 * el frontend no puede robar el token y usarlo desde afuera del navegador.
 */

export const ACCESS_COOKIE = 'mt_at';
export const REFRESH_COOKIE = 'mt_rt';
export const CSRF_COOKIE = 'mt_csrf';

const ACCESS_MAXAGE_MS = 15 * 60 * 1000;

function baseCookieOpts() {
  // Cross-site en producción (frontend en Vercel, backend en Railway): hace
  // falta SameSite=None+Secure. En dev, mismo "site" (localhost) alcanza con
  // Lax y no requiere HTTPS, que no existe en local.
  return {
    httpOnly: true as const,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
  };
}

export function setAccessCookie(res: Response, token: string) {
  res.cookie(ACCESS_COOKIE, token, { ...baseCookieOpts(), maxAge: ACCESS_MAXAGE_MS });
}

export function setRefreshCookie(res: Response, token: string, dias: number) {
  // Restringido a /api/auth: sólo se envía en los endpoints que lo necesitan.
  res.cookie(REFRESH_COOKIE, token, {
    ...baseCookieOpts(),
    path: '/api/auth',
    maxAge: dias * 24 * 60 * 60 * 1000,
  });
}

export function setCsrfCookie(res: Response): string {
  const token = crypto.randomBytes(24).toString('hex');
  res.cookie(CSRF_COOKIE, token, { ...baseCookieOpts(), httpOnly: false, maxAge: ACCESS_MAXAGE_MS });
  return token;
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookieOpts() });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookieOpts(), path: '/api/auth' });
  res.clearCookie(CSRF_COOKIE, { ...baseCookieOpts(), httpOnly: false });
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function hashDevice(req: Request): string {
  const ua = req.header('user-agent') || '';
  return crypto.createHash('sha256').update(`${ua}|${req.ip || ''}`).digest('hex');
}

interface CrearSesionParams {
  usuarioId: string;
  req: Request;
  recordar: boolean;
  reemplazaA?: string;
}

/** Crea una fila de sesión nueva y devuelve el refresh token en claro (sólo existe acá, nunca se persiste). */
export async function crearSesion({ usuarioId, req, recordar, reemplazaA }: CrearSesionParams) {
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const dias = recordar ? env.REFRESH_TTL_RECORDAR_DIAS : env.REFRESH_TTL_DIAS;
  const expiraEn = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO sesiones (usuario_id, refresh_token_hash, device_hash, user_agent, ip, recordar, reemplaza_a, expira_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      usuarioId,
      hashToken(refreshToken),
      hashDevice(req),
      req.header('user-agent') || null,
      req.ip || null,
      recordar,
      reemplazaA ?? null,
      expiraEn,
    ],
  );

  return { refreshToken, dias };
}

export async function revocarSesionPorId(id: string) {
  await query('UPDATE sesiones SET revocada_en = now() WHERE id = $1 AND revocada_en IS NULL', [id]);
}

export async function revocarSesionPorHash(refreshTokenHash: string) {
  await query('UPDATE sesiones SET revocada_en = now() WHERE refresh_token_hash = $1 AND revocada_en IS NULL', [refreshTokenHash]);
}

/** Tumba todas las sesiones activas de un usuario: se usa ante robo de refresh token, cambio de contraseña, etc. */
export async function revocarTodasLasSesiones(usuarioId: string) {
  await query('UPDATE sesiones SET revocada_en = now() WHERE usuario_id = $1 AND revocada_en IS NULL', [usuarioId]);
}
