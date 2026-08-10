import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from '../../config/db';
import { env } from '../../config/env';
import { requireAuth } from '../../middleware/rbac';
import { requireCsrf } from '../../middleware/csrf';
import { loginLimiter, refreshLimiter, forgotPasswordLimiter, mfaLimiter } from '../../middleware/rateLimit';
import { registrarEventoAuth } from '../../services/auth-log.service';
import { crearTokenAccion, consumirTokenAccion } from '../../services/token-accion.service';
import { enviarResetPassword, enviarPasswordCambiada, enviarAlertaDispositivoNuevo, enviarCodigoMfa } from '../../services/email.service';
import {
  generarSecretoTotp,
  cifrarSecreto,
  descifrarSecreto,
  generarQrDataUrl,
  verificarTotp,
  generarCodigosRespaldo,
  verificarCodigoRespaldo,
} from '../../services/mfa.service';
import {
  crearChallenge,
  obtenerChallenge,
  eliminarChallenge,
  asignarCodigoEmail,
  verificarCodigoEmailChallenge,
} from '../../services/mfa-challenge.store';
import { generarCodigoNumerico, guardarCodigoAlta, verificarCodigoAlta } from '../../services/email-mfa.store';
import { validarPassword } from '../../services/password-policy.service';
import {
  REFRESH_COOKIE,
  crearSesion,
  revocarSesionPorId,
  revocarSesionPorHash,
  revocarTodasLasSesiones,
  hashToken,
  hashDevice,
  setAccessCookie,
  setRefreshCookie,
  setCsrfCookie,
  clearAuthCookies,
} from '../../services/session.service';

export const authRouter = Router();

// Bloqueo por cuenta: segunda capa además del rate-limit por IP (ver
// middleware/rateLimit.ts) — este frena a alguien que reparte los intentos
// entre varias IPs, algo que un límite por IP no puede ver.
const MAX_INTENTOS_FALLIDOS = 5;
const BLOQUEO_MINUTOS = 1; // TEMPORAL para pruebas — volver a 15 cuando terminen de probar

interface UsuarioFila {
  id: string;
  email: string;
  rol: string;
  activo: boolean;
  token_version: number;
}

function firmarAccessToken(user: UsuarioFila) {
  return jwt.sign(
    { id: user.id, email: user.email, rol: user.rol, tv: user.token_version },
    env.JWT_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES as any },
  );
}

/** Emite un par de cookies (access + refresh) nuevo para un usuario ya autenticado. */
async function emitirSesion(res: Response, req: Request, user: UsuarioFila, recordar: boolean, reemplazaA?: string) {
  const accessToken = firmarAccessToken(user);
  const { refreshToken, dias } = await crearSesion({ usuarioId: user.id, req, recordar, reemplazaA });
  setAccessCookie(res, accessToken);
  setRefreshCookie(res, refreshToken, dias);
  setCsrfCookie(res);
  await query('UPDATE usuarios SET ultima_conexion = now() WHERE id = $1', [user.id]);
}

/**
 * Si el device_hash (user-agent+IP) no está en `dispositivos_conocidos` para
 * este usuario, lo registra y dispara un email de alerta. El envío del email
 * no bloquea la respuesta del login (es best-effort: si falla, se loguea y
 * listo, no rompe el inicio de sesión).
 */
async function chequearDispositivoNuevo(usuarioId: string, email: string, req: Request) {
  const deviceHash = hashDevice(req);
  const rows = await query<{ id: string }>(
    'SELECT id FROM dispositivos_conocidos WHERE usuario_id = $1 AND device_hash = $2',
    [usuarioId, deviceHash],
  );
  if (rows.length > 0) {
    await query('UPDATE dispositivos_conocidos SET ultima_vez = now() WHERE id = $1', [rows[0].id]);
    return;
  }

  await query(
    `INSERT INTO dispositivos_conocidos (usuario_id, device_hash, user_agent, ip_primera_vez) VALUES ($1,$2,$3,$4)`,
    [usuarioId, deviceHash, req.header('user-agent') || null, req.ip || null],
  );
  await registrarEventoAuth({ usuarioId, email, tipo: 'dispositivo_nuevo', req });
  enviarAlertaDispositivoNuevo(email, { ip: req.ip || null, userAgent: req.header('user-agent') || null, fecha: new Date() })
    .catch((e) => console.error('No se pudo enviar la alerta de dispositivo nuevo:', e));
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  recordar: z.boolean().optional().default(false),
});

authRouter.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { email, password, recordar } = parsed.data;

  const rows = await query<
    UsuarioFila & {
      password_hash: string;
      failed_attempts: number;
      locked_until: string | null;
      mfa_enabled: boolean;
      mfa_secret_enc: string | null;
    }
  >(
    'SELECT id, email, rol, password_hash, activo, token_version, failed_attempts, locked_until, mfa_enabled, mfa_secret_enc FROM usuarios WHERE email = $1',
    [email],
  );
  const user = rows[0];

  if (!user || !user.activo) {
    await registrarEventoAuth({ email, tipo: 'login_fallido', req, detalle: { motivo: user ? 'inactivo' : 'no_existe' } });
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await registrarEventoAuth({ usuarioId: user.id, email, tipo: 'login_fallido', req, detalle: { motivo: 'cuenta_bloqueada' } });
    return res.status(423).json({ error: 'Cuenta bloqueada temporalmente por demasiados intentos fallidos. Probá de nuevo en unos minutos.' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const intentos = user.failed_attempts + 1;
    if (intentos >= MAX_INTENTOS_FALLIDOS) {
      const lockedUntil = new Date(Date.now() + BLOQUEO_MINUTOS * 60 * 1000);
      await query('UPDATE usuarios SET failed_attempts = 0, locked_until = $2 WHERE id = $1', [user.id, lockedUntil]);
      await registrarEventoAuth({ usuarioId: user.id, email, tipo: 'bloqueo_temporal', req, detalle: { intentos } });
    } else {
      await query('UPDATE usuarios SET failed_attempts = $2 WHERE id = $1', [user.id, intentos]);
    }
    await registrarEventoAuth({ usuarioId: user.id, email, tipo: 'login_fallido', req, detalle: { intentos } });
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  if (user.failed_attempts > 0 || user.locked_until) {
    await query('UPDATE usuarios SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
  }

  if (user.mfa_enabled) {
    // No se emite sesión todavía: falta el segundo factor. El challenge
    // vive en memoria (ver mfa-challenge.store.ts) y expira en 5 min.
    const challengeId = crearChallenge(user.id, req.ip || null, recordar);
    if (user.mfa_secret_enc) {
      return res.json({ mfaRequired: true, challengeId, metodo: 'totp' });
    }
    // Método email: no hay secreto guardado, el código se genera y manda recién ahora.
    const codigo = generarCodigoNumerico();
    asignarCodigoEmail(challengeId, codigo);
    enviarCodigoMfa(user.email, codigo).catch((e) => console.error('No se pudo enviar el código de MFA por email:', e));
    return res.json({ mfaRequired: true, challengeId, metodo: 'email' });
  }

  await emitirSesion(res, req, user, recordar);
  await registrarEventoAuth({ usuarioId: user.id, email, tipo: 'login_exitoso', req });
  await chequearDispositivoNuevo(user.id, user.email, req);
  res.json({ user: { id: user.id, email: user.email, rol: user.rol, mfaEnabled: false, mfaMetodo: null } });
});

const mfaVerifySchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(6).max(9),
});

/**
 * Segundo paso del login cuando el usuario tiene MFA activado. Acepta un
 * código TOTP de 6 dígitos o uno de los 10 códigos de respaldo (formato
 * "xxxx-xxxx", de un solo uso). El bloqueo por cuenta (failed_attempts/
 * locked_until) es el mismo que en /login: fallar acá cuenta igual que
 * fallar la contraseña.
 */
authRouter.post('/mfa/verify', mfaLimiter, async (req: Request, res: Response) => {
  const parsed = mfaVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { challengeId, code } = parsed.data;

  const challenge = obtenerChallenge(challengeId);
  if (!challenge) return res.status(401).json({ error: 'El código venció, iniciá sesión de nuevo.' });

  const rows = await query<
    UsuarioFila & {
      mfa_secret_enc: string | null;
      mfa_backup_codes: string[];
      failed_attempts: number;
      locked_until: string | null;
    }
  >(
    'SELECT id, email, rol, activo, token_version, mfa_secret_enc, mfa_backup_codes, failed_attempts, locked_until FROM usuarios WHERE id = $1',
    [challenge.usuarioId],
  );
  const user = rows[0];
  if (!user || !user.activo) {
    eliminarChallenge(challengeId);
    return res.status(401).json({ error: 'Sesión inválida, iniciá sesión de nuevo.' });
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(423).json({ error: 'Cuenta bloqueada temporalmente por demasiados intentos fallidos. Probá de nuevo en unos minutos.' });
  }

  const codigo = code.trim();
  let ok = false;
  let viaBackup = false;
  if (/^\d{6}$/.test(codigo)) {
    // Un código de 6 dígitos puede ser TOTP (app) o el que se mandó por email, según el método del usuario.
    ok = user.mfa_secret_enc
      ? verificarTotp(codigo, descifrarSecreto(user.mfa_secret_enc))
      : verificarCodigoEmailChallenge(challengeId, codigo);
  } else {
    const idx = await verificarCodigoRespaldo(codigo, user.mfa_backup_codes);
    if (idx >= 0) {
      ok = true;
      viaBackup = true;
      const restantes = user.mfa_backup_codes.filter((_, i) => i !== idx);
      await query('UPDATE usuarios SET mfa_backup_codes = $2 WHERE id = $1', [user.id, restantes]);
    }
  }

  if (!ok) {
    const intentos = user.failed_attempts + 1;
    if (intentos >= MAX_INTENTOS_FALLIDOS) {
      const lockedUntil = new Date(Date.now() + BLOQUEO_MINUTOS * 60 * 1000);
      await query('UPDATE usuarios SET failed_attempts = 0, locked_until = $2 WHERE id = $1', [user.id, lockedUntil]);
      await registrarEventoAuth({ usuarioId: user.id, email: user.email, tipo: 'bloqueo_temporal', req, detalle: { intentos, via: 'mfa' } });
    } else {
      await query('UPDATE usuarios SET failed_attempts = $2 WHERE id = $1', [user.id, intentos]);
    }
    await registrarEventoAuth({ usuarioId: user.id, email: user.email, tipo: 'mfa_fallido', req, detalle: { intentos } });
    return res.status(401).json({ error: 'Código inválido' });
  }

  eliminarChallenge(challengeId);
  if (user.failed_attempts > 0 || user.locked_until) {
    await query('UPDATE usuarios SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
  }

  await emitirSesion(res, req, user, challenge.recordar);
  await registrarEventoAuth({ usuarioId: user.id, email: user.email, tipo: 'login_exitoso', req, detalle: { via: viaBackup ? 'mfa_backup' : 'mfa' } });
  await chequearDispositivoNuevo(user.id, user.email, req);
  res.json({
    user: { id: user.id, email: user.email, rol: user.rol, mfaEnabled: true, mfaMetodo: user.mfa_secret_enc ? 'totp' : 'email' },
    backupCodeUsado: viaBackup,
  });
});

const mfaReenviarSchema = z.object({ challengeId: z.string().min(1) });

/** Reenvía el código por email de un challenge de login en curso (no aplica al método TOTP, ese código lo genera la app sola). */
authRouter.post('/mfa/reenviar', mfaLimiter, async (req: Request, res: Response) => {
  const parsed = mfaReenviarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });

  const challenge = obtenerChallenge(parsed.data.challengeId);
  if (!challenge) return res.status(401).json({ error: 'El código venció, iniciá sesión de nuevo.' });

  const rows = await query<{ email: string; mfa_secret_enc: string | null }>(
    'SELECT email, mfa_secret_enc FROM usuarios WHERE id = $1',
    [challenge.usuarioId],
  );
  const user = rows[0];
  if (!user || user.mfa_secret_enc) return res.status(400).json({ error: 'No corresponde reenviar un código acá' });

  const codigo = generarCodigoNumerico();
  asignarCodigoEmail(parsed.data.challengeId, codigo);
  enviarCodigoMfa(user.email, codigo).catch((e) => console.error('No se pudo reenviar el código de MFA por email:', e));
  res.json({ ok: true });
});

const forgotPasswordSchema = z.object({ email: z.string().email() });

/** Siempre responde igual, exista o no el email: no hay que dejar adivinar qué cuentas existen. */
authRouter.post('/forgot-password', forgotPasswordLimiter, async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { email } = parsed.data;

  const rows = await query<{ id: string; activo: boolean }>('SELECT id, activo FROM usuarios WHERE email = $1', [email]);
  const user = rows[0];
  if (user && user.activo) {
    const token = await crearTokenAccion(user.id, 'reset_password');
    await enviarResetPassword(email, token);
    await registrarEventoAuth({ usuarioId: user.id, email, tipo: 'password_reset_solicitado', req });
  }
  res.json({ ok: true });
});

const setPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Un solo endpoint para los dos flujos que terminan en "elegir contraseña
 * con un link de un solo uso": aceptar una invitación de alta y restablecer
 * una olvidada. En ambos casos deja al usuario logueado directamente.
 */
authRouter.post('/set-password', async (req: Request, res: Response) => {
  const parsed = setPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
  const { token, password } = parsed.data;

  // Se valida ANTES de consumir el token: si el token se quemara con una
  // contraseña que después resulta rechazada, el usuario se quedaría sin
  // link y tendría que pedir uno nuevo solo por haber tipeado algo débil.
  const errorPassword = await validarPassword(password);
  if (errorPassword) return res.status(400).json({ error: errorPassword });

  let usuarioId = await consumirTokenAccion(token, 'reset_password');
  let esInvitacion = false;
  if (!usuarioId) {
    usuarioId = await consumirTokenAccion(token, 'invitacion');
    esInvitacion = true;
  }
  if (!usuarioId) return res.status(400).json({ error: 'El link es inválido o venció. Pedí uno nuevo.' });

  const hash = await bcrypt.hash(password, 10);
  const rows = await query<UsuarioFila & { mfa_enabled: boolean; mfa_secret_enc: string | null }>(
    `UPDATE usuarios SET password_hash = $2, token_version = token_version + 1, failed_attempts = 0, locked_until = NULL
     WHERE id = $1 RETURNING id, email, rol, activo, token_version, mfa_enabled, mfa_secret_enc`,
    [usuarioId, hash],
  );
  const user = rows[0];
  if (!user || !user.activo) return res.status(400).json({ error: 'Cuenta inexistente o inactiva' });

  await revocarTodasLasSesiones(user.id);
  await emitirSesion(res, req, user, false);
  await registrarEventoAuth({
    usuarioId: user.id,
    email: user.email,
    tipo: esInvitacion ? 'login_exitoso' : 'password_reset_exitoso',
    req,
  });
  if (!esInvitacion) enviarPasswordCambiada(user.email).catch((e) => console.error('No se pudo enviar la notificación de cambio de contraseña:', e));
  // Registra este dispositivo como conocido: si no, el próximo login "real"
  // desde el mismo navegador se marcaría como dispositivo nuevo sin serlo.
  await chequearDispositivoNuevo(user.id, user.email, req);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      rol: user.rol,
      mfaEnabled: user.mfa_enabled,
      mfaMetodo: !user.mfa_enabled ? null : user.mfa_secret_enc ? 'totp' : 'email',
    },
  });
});

/**
 * Intercambia el refresh token de la cookie por un par nuevo. Rota el
 * refresh en cada uso: si alguien reutiliza uno ya consumido (robado), se
 * interpreta como compromiso de la sesión y se revocan todas las sesiones
 * activas del usuario, forzando un login limpio en todos los dispositivos.
 */
authRouter.post('/refresh', refreshLimiter, requireCsrf, async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return res.status(401).json({ error: 'No hay sesión' });

  const tokenHash = hashToken(token);
  const rows = await query<{
    id: string;
    usuario_id: string;
    revocada_en: string | null;
    expira_en: string;
    recordar: boolean;
  }>('SELECT id, usuario_id, revocada_en, expira_en, recordar FROM sesiones WHERE refresh_token_hash = $1', [tokenHash]);
  const sesion = rows[0];

  if (!sesion) {
    clearAuthCookies(res);
    return res.status(401).json({ error: 'Sesión inválida' });
  }
  if (sesion.revocada_en) {
    await revocarTodasLasSesiones(sesion.usuario_id);
    await registrarEventoAuth({ usuarioId: sesion.usuario_id, tipo: 'refresh_reutilizado', req, detalle: { sesionId: sesion.id } });
    clearAuthCookies(res);
    return res.status(401).json({ error: 'Sesión inválida, iniciá sesión de nuevo' });
  }
  if (new Date(sesion.expira_en) < new Date()) {
    clearAuthCookies(res);
    return res.status(401).json({ error: 'Sesión expirada' });
  }

  const userRows = await query<UsuarioFila>(
    'SELECT id, email, rol, activo, token_version FROM usuarios WHERE id = $1',
    [sesion.usuario_id],
  );
  const user = userRows[0];
  if (!user || !user.activo) {
    clearAuthCookies(res);
    return res.status(401).json({ error: 'Sesión inválida' });
  }

  await revocarSesionPorId(sesion.id);
  await emitirSesion(res, req, user, sesion.recordar, sesion.id);
  res.json({ user: { id: user.id, email: user.email, rol: user.rol } });
});

authRouter.post('/logout', requireCsrf, async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) {
    const tokenHash = hashToken(token);
    const [sesion] = await query<{ usuario_id: string }>(
      'SELECT usuario_id FROM sesiones WHERE refresh_token_hash = $1',
      [tokenHash],
    );
    await revocarSesionPorHash(tokenHash);
    if (sesion) await registrarEventoAuth({ usuarioId: sesion.usuario_id, tipo: 'logout', req });
  }
  clearAuthCookies(res);
  res.status(204).end();
});

/** Usado por el frontend al cargar la app para saber si ya hay sesión (la cookie httpOnly no se puede leer desde JS). */
authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  const rows = await query<{ mfa_enabled: boolean; mfa_secret_enc: string | null }>(
    'SELECT mfa_enabled, mfa_secret_enc FROM usuarios WHERE id = $1',
    [req.user!.id],
  );
  const fila = rows[0];
  res.json({
    user: {
      id: req.user!.id,
      email: req.user!.email,
      rol: req.user!.rol,
      mfaEnabled: fila?.mfa_enabled ?? false,
      mfaMetodo: !fila?.mfa_enabled ? null : fila.mfa_secret_enc ? 'totp' : 'email',
    },
  });
});

/** Genera un secreto TOTP nuevo (todavía no activado) y su QR. Se puede llamar de nuevo para regenerar el secreto mientras no se haya confirmado. */
authRouter.post('/mfa/setup/iniciar', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const secreto = generarSecretoTotp();
  await query('UPDATE usuarios SET mfa_secret_enc = $2 WHERE id = $1', [req.user!.id, cifrarSecreto(secreto)]);
  const qr = await generarQrDataUrl(req.user!.email, secreto);
  res.json({ qr, secreto });
});

const confirmarMfaSchema = z.object({ code: z.string().length(6) });

/** Confirma el primer código TOTP y recién ahí activa MFA — evita que un QR mal escaneado deje al usuario sin poder loguearse nunca más. */
authRouter.post('/mfa/setup/confirmar', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const parsed = confirmarMfaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'El código debe tener 6 dígitos' });

  const rows = await query<{ mfa_secret_enc: string | null }>('SELECT mfa_secret_enc FROM usuarios WHERE id = $1', [req.user!.id]);
  const secretoEnc = rows[0]?.mfa_secret_enc;
  if (!secretoEnc) return res.status(400).json({ error: 'Iniciá la configuración de MFA primero' });
  if (!verificarTotp(parsed.data.code, descifrarSecreto(secretoEnc))) {
    return res.status(401).json({ error: 'Código inválido' });
  }

  const { codigos, hashes } = await generarCodigosRespaldo();
  await query('UPDATE usuarios SET mfa_enabled = TRUE, mfa_backup_codes = $2 WHERE id = $1', [req.user!.id, hashes]);
  await registrarEventoAuth({ usuarioId: req.user!.id, email: req.user!.email, tipo: 'mfa_activado', req });
  res.json({ codigosRespaldo: codigos });
});

/**
 * Alta de MFA método "email": alternativa a la app authenticator, sin QR ni
 * instalar nada — pensada para el staff menos técnico. Manda un código de
 * verificación a la casilla del propio usuario para confirmar que la puede leer.
 */
authRouter.post('/mfa/setup/email/enviar', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const codigo = generarCodigoNumerico();
  guardarCodigoAlta(req.user!.id, codigo);
  const enviado = await enviarCodigoMfa(req.user!.email, codigo);
  if (!enviado) return res.status(502).json({ error: 'No se pudo enviar el email. Probá de nuevo en un momento.' });
  res.json({ ok: true });
});

const confirmarMfaEmailSchema = z.object({ code: z.string().length(6) });

authRouter.post('/mfa/setup/email/confirmar', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const parsed = confirmarMfaEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'El código debe tener 6 dígitos' });

  if (!verificarCodigoAlta(req.user!.id, parsed.data.code)) {
    return res.status(401).json({ error: 'Código inválido o vencido' });
  }

  // mfa_secret_enc queda en NULL a propósito: así login/mfa-verify sabe que
  // el método de este usuario es "email" y no "app" (ver /login y /mfa/verify).
  const { codigos, hashes } = await generarCodigosRespaldo();
  await query('UPDATE usuarios SET mfa_enabled = TRUE, mfa_backup_codes = $2 WHERE id = $1', [req.user!.id, hashes]);
  await registrarEventoAuth({ usuarioId: req.user!.id, email: req.user!.email, tipo: 'mfa_activado', req, detalle: { metodo: 'email' } });
  res.json({ codigosRespaldo: codigos });
});

const passwordConfirmSchema = z.object({ password: z.string().min(1) });

/** Desactivar MFA exige la contraseña actual: si alguien secuestró la sesión, no alcanza con eso solo para bajar la guardia del panel. */
authRouter.post('/mfa/desactivar', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const parsed = passwordConfirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });

  const rows = await query<{ password_hash: string }>('SELECT password_hash FROM usuarios WHERE id = $1', [req.user!.id]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  await query(
    `UPDATE usuarios SET mfa_enabled = FALSE, mfa_secret_enc = NULL, mfa_backup_codes = '{}', token_version = token_version + 1 WHERE id = $1`,
    [req.user!.id],
  );
  await revocarTodasLasSesiones(req.user!.id);
  await registrarEventoAuth({ usuarioId: req.user!.id, email: req.user!.email, tipo: 'mfa_desactivado', req });
  clearAuthCookies(res);
  res.status(204).end();
});

/** Igual que desactivar, requiere la contraseña actual: invalida los códigos viejos (por si alguien los vio) y entrega 10 nuevos. */
authRouter.post('/mfa/backup-codes/regenerar', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const parsed = passwordConfirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });

  const rows = await query<{ password_hash: string; mfa_enabled: boolean }>(
    'SELECT password_hash, mfa_enabled FROM usuarios WHERE id = $1',
    [req.user!.id],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  if (!user.mfa_enabled) return res.status(400).json({ error: 'MFA no está activado' });

  const { codigos, hashes } = await generarCodigosRespaldo();
  await query('UPDATE usuarios SET mfa_backup_codes = $2 WHERE id = $1', [req.user!.id, hashes]);
  res.json({ codigosRespaldo: codigos });
});
