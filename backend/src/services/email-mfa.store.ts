import crypto from 'crypto';

/**
 * Códigos de un solo uso para el método "MFA por email": tanto para el alta
 * (confirmar que el usuario puede leer su correo) como, vía mfa-challenge.store,
 * para el login. En memoria — mismo criterio que el resto de esta fase
 * (rate-limit, challenges de MFA): alcanza con una sola instancia.
 */
interface CodigoAlta {
  codigoHash: string;
  expiraEn: number;
}

const TTL_MS = 10 * 60 * 1000;
const codigosAlta = new Map<string, CodigoAlta>(); // key: usuarioId

setInterval(() => {
  const ahora = Date.now();
  for (const [id, c] of codigosAlta) if (c.expiraEn < ahora) codigosAlta.delete(id);
}, 10 * 60 * 1000).unref();

export function generarCodigoNumerico(digitos = 6): string {
  const max = 10 ** digitos;
  return crypto.randomInt(0, max).toString().padStart(digitos, '0');
}

export function hashCodigo(codigo: string): string {
  return crypto.createHash('sha256').update(codigo).digest('hex');
}

export function guardarCodigoAlta(usuarioId: string, codigo: string) {
  codigosAlta.set(usuarioId, { codigoHash: hashCodigo(codigo), expiraEn: Date.now() + TTL_MS });
}

export function verificarCodigoAlta(usuarioId: string, codigo: string): boolean {
  const c = codigosAlta.get(usuarioId);
  if (!c || c.expiraEn < Date.now()) return false;
  const ok = c.codigoHash === hashCodigo(codigo);
  if (ok) codigosAlta.delete(usuarioId); // de un solo uso
  return ok;
}
