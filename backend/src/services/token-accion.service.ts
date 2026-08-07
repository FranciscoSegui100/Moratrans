import crypto from 'crypto';
import { query } from '../config/db';
import { hashToken } from './session.service';

export type TipoTokenAccion = 'invitacion' | 'reset_password';

const TTL_MINUTOS = 30;

/** Genera un token de un solo uso (invitación / reset), lo guarda hasheado y devuelve el valor en claro (solo existe acá, para el link del email). */
export async function crearTokenAccion(usuarioId: string, tipo: TipoTokenAccion): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiraEn = new Date(Date.now() + TTL_MINUTOS * 60 * 1000);
  await query(
    `INSERT INTO tokens_accion (usuario_id, tipo, token_hash, expira_en) VALUES ($1,$2,$3,$4)`,
    [usuarioId, tipo, hashToken(token), expiraEn],
  );
  return token;
}

/**
 * Valida y consume un token de un solo uso. Devuelve el usuario_id si es
 * válido (existe, no vencido, no usado, del tipo esperado) o null si no.
 * Consumirlo (marcar usado_en) pasa en la misma llamada para que dos
 * requests con el mismo token en paralelo no puedan usarlo dos veces.
 */
export async function consumirTokenAccion(token: string, tipo: TipoTokenAccion): Promise<string | null> {
  const rows = await query<{ usuario_id: string }>(
    `UPDATE tokens_accion
       SET usado_en = now()
     WHERE token_hash = $1 AND tipo = $2 AND usado_en IS NULL AND expira_en > now()
     RETURNING usuario_id`,
    [hashToken(token), tipo],
  );
  return rows[0]?.usuario_id ?? null;
}
