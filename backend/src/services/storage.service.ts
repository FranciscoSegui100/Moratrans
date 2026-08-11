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
