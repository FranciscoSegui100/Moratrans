import { Request } from 'express';
import { query } from '../config/db';

export type TipoEventoAuth =
  | 'login_exitoso'
  | 'login_fallido'
  | 'mfa_fallido'
  | 'bloqueo_temporal'
  | 'logout'
  | 'password_reset_solicitado'
  | 'password_reset_exitoso'
  | 'dispositivo_nuevo'
  | 'sesion_revocada'
  | 'refresh_reutilizado'
  | 'mfa_activado'
  | 'mfa_desactivado';

interface RegistrarEventoParams {
  usuarioId?: string | null;
  email?: string | null;
  tipo: TipoEventoAuth;
  req: Request;
  detalle?: Record<string, unknown>;
}

/** Auditoría de autenticación: nunca debe tumbar el flujo principal si falla. */
export async function registrarEventoAuth({ usuarioId, email, tipo, req, detalle }: RegistrarEventoParams) {
  try {
    await query(
      `INSERT INTO auth_eventos (usuario_id, email, tipo, ip, user_agent, detalle)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        usuarioId ?? null,
        email ?? null,
        tipo,
        req.ip ?? null,
        req.header('user-agent') ?? null,
        detalle ? JSON.stringify(detalle) : null,
      ],
    );
  } catch (e) {
    console.error('No se pudo registrar evento de auth:', e);
  }
}
