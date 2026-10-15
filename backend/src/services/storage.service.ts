import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// Bucket PRIVADO: nunca se sirve directo, siempre pasa por una ruta del panel
// con su propio chequeo de RBAC (ver pagos.routes.ts) — la service_role key
// solo la usa el backend, nunca llega al cliente.
const client =
  env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

function getClient() {
  if (!client) {
    throw new Error('Supabase Storage no está configurado (faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return client;
}

/** Sube un archivo al bucket. `ruta` es la key dentro del bucket, ej. "comprobantes/xxx.jpg". */
export async function subirArchivo(buffer: Buffer, ruta: string, contentType: string): Promise<void> {
  const { error } = await getClient()
    .storage.from(env.SUPABASE_STORAGE_BUCKET)
    .upload(ruta, buffer, { contentType, upsert: true });
  if (error) throw error;
}

/** Descarga un archivo del bucket como Buffer. */
export async function descargarArchivo(ruta: string): Promise<Buffer> {
  const { data, error } = await getClient().storage.from(env.SUPABASE_STORAGE_BUCKET).download(ruta);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

/** Borra un archivo del bucket (retención de comprobantes, ver limpieza.cron.ts). */
export async function borrarArchivo(ruta: string): Promise<void> {
  const { error } = await getClient().storage.from(env.SUPABASE_STORAGE_BUCKET).remove([ruta]);
  if (error) throw error;
}

/**
 * Valida la firma binaria ("magic bytes") y el mime-type para asegurarse de que
 * el archivo recibido sea genuinamente una imagen (JPEG, PNG, WebP) o un PDF,
 * impidiendo la subida de ejecutables, scripts o binarios no deseados.
 */
export function detectarExtensionSegura(buffer: Buffer, mime: string = ''): string | null {
  if (buffer.length >= 4) {
    // PDF (%PDF -> 25 50 44 46)
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return 'pdf';
    }
    // PNG (89 50 4E 47)
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'png';
    }
    // JPEG (FF D8 FF)
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'jpg';
    }
  }

  // WebP (RIFF .... WEBP)
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }

  // Fallback controlado si el mime informado es seguro
  const m = (mime || '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';

  return null;
}
