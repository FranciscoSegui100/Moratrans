import crypto from 'crypto';
import { hashCodigo } from './email-mfa.store';

/**
 * Challenges de MFA en memoria: igual que el rate-limit (ver
 * middleware/rateLimit.ts), alcanza mientras el backend corra en una sola
 * instancia. Si se migra a Redis, este es el store a reemplazar.
 */
interface Challenge {
  usuarioId: string;
  ip: string | null;
  recordar: boolean;
  expiraEn: number;
  /** Solo si el método de MFA del usuario es "email": hash del código que se le mandó para este login. */
  codigoEmailHash?: string;
}

const TTL_MS = 5 * 60 * 1000;
const challenges = new Map<string, Challenge>();

// Barre challenges vencidos cada 10 min para no acumular memoria indefinidamente.
setInterval(() => {
  const ahora = Date.now();
  for (const [id, c] of challenges) if (c.expiraEn < ahora) challenges.delete(id);
}, 10 * 60 * 1000).unref();

export function crearChallenge(usuarioId: string, ip: string | null, recordar: boolean): string {
  const id = crypto.randomBytes(24).toString('hex');
  challenges.set(id, { usuarioId, ip, recordar, expiraEn: Date.now() + TTL_MS });
  return id;
}

/** Solo lectura: no se borra al mirar, para permitir reintentar un código mal tipeado dentro del TTL. */
export function obtenerChallenge(id: string): Challenge | null {
  const c = challenges.get(id);
  if (!c) return null;
  if (c.expiraEn < Date.now()) {
    challenges.delete(id);
    return null;
  }
  return c;
}

export function eliminarChallenge(id: string) {
  challenges.delete(id);
}

/** Genera y asocia un código de un solo uso (método email) a un challenge ya creado. Devuelve el código en claro para mandarlo por correo. */
export function asignarCodigoEmail(challengeId: string, codigo: string) {
  const c = challenges.get(challengeId);
  if (c) c.codigoEmailHash = hashCodigo(codigo);
}

export function verificarCodigoEmailChallenge(challengeId: string, codigo: string): boolean {
  const c = challenges.get(challengeId);
  return !!c?.codigoEmailHash && c.codigoEmailHash === hashCodigo(codigo);
}
