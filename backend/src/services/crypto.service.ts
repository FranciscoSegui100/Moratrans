import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Cifrado en reposo de campos sensibles (DNI, URL de comprobantes).
 *
 * - Cifrado: AES-256-GCM con IV aleatorio por valor. La clave vive SOLO en la
 *   variable de entorno ENCRYPTION_KEY (idealmente inyectada desde un KMS /
 *   Secret Manager), nunca en la base de datos ni en los logs de SQL.
 * - Búsqueda: como AES-GCM produce ciphertext distinto cada vez, no se puede
 *   hacer `WHERE dni = ...`. Para eso guardamos además un "blind index":
 *   un HMAC-SHA256 determinístico del valor, que permite igualdad exacta sin
 *   revelar el dato.
 */

const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex'); // 32 bytes
const ALGO = 'aes-256-gcm';

/** Cifra un texto -> "ivB64:tagB64:dataB64". */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Descifra el formato anterior. Devuelve '' si el input es nulo/inválido. */
export function decrypt(ciphertext: string | null | undefined): string {
  if (!ciphertext) return '';
  try {
    const [ivB64, tagB64, dataB64] = ciphertext.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Cifra un buffer binario (contenido de archivo: comprobante/factura) ->
 * [iv(12)][tag(16)][ciphertext]. A diferencia de `encrypt()`, esto no cifra
 * la referencia/ruta del archivo sino el contenido en sí antes de subirlo al
 * storage de terceros — así el bucket nunca guarda el binario en claro,
 * aunque su configuración de privacidad falle o cambie (sección 9).
 */
export function encryptBuffer(data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/** Descifra un buffer cifrado con `encryptBuffer()`. */
export function decryptBuffer(data: Buffer): Buffer {
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/**
 * Blind index determinístico (HMAC-SHA256) para búsquedas por igualdad.
 * Deriva su propia subclave desde ENCRYPTION_KEY para no reutilizar la clave AES.
 */
const HMAC_KEY = crypto.createHmac('sha256', KEY).update('blind-index-v1').digest();
export function blindIndex(value: string): string {
  return crypto.createHmac('sha256', HMAC_KEY).update(value.trim()).digest('hex');
}
