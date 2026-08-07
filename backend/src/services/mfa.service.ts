import crypto from 'crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from './crypto.service';

// Tolera 1 paso de 30s antes/después: relojes de celular ligeramente
// desincronizados no deberían trabar a nadie afuera del panel.
authenticator.options = { window: 1 };

const ISSUER = 'Moratrans';

export function generarSecretoTotp(): string {
  return authenticator.generateSecret();
}

/** Cifra el secreto (AES-256-GCM, mismo servicio que DNI/comprobantes) antes de guardarlo. */
export function cifrarSecreto(secreto: string): string {
  return encrypt(secreto);
}

export function descifrarSecreto(secretoCifrado: string): string {
  return decrypt(secretoCifrado);
}

export async function generarQrDataUrl(email: string, secreto: string): Promise<string> {
  const otpauth = authenticator.keyuri(email, ISSUER, secreto);
  return QRCode.toDataURL(otpauth);
}

export function verificarTotp(code: string, secreto: string): boolean {
  try {
    return authenticator.verify({ token: code, secret: secreto });
  } catch {
    return false;
  }
}

/** 10 códigos de respaldo tipo "xxxx-xxxx". Devuelve los códigos en claro (para mostrar una sola vez) y sus hashes (para guardar). */
export async function generarCodigosRespaldo(): Promise<{ codigos: string[]; hashes: string[] }> {
  const codigos: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const raw = crypto.randomBytes(4).toString('hex');
    const codigo = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    codigos.push(codigo);
    hashes.push(await bcrypt.hash(codigo, 10));
  }
  return { codigos, hashes };
}

/** Compara un código de respaldo contra la lista hasheada. Devuelve el índice consumido o -1. */
export async function verificarCodigoRespaldo(code: string, hashes: string[]): Promise<number> {
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(code, hashes[i])) return i;
  }
  return -1;
}
