/**
 * Rotación de ENCRYPTION_KEY: descifra con la clave vieja lo que ya está
 * guardado (DNI de choferes, comprobantes/facturas, secreto TOTP de MFA) y
 * lo vuelve a cifrar/indexar con la nueva. También re-encripta el CONTENIDO
 * BINARIO de comprobantes/facturas en Supabase Storage (no solo la ruta en
 * la DB) — desde que ese binario se sube cifrado (sección 9, ver
 * crypto.service.ts encryptBuffer/decryptBuffer), rotar la clave sin esto
 * dejaba archivos viejos ilegibles con la clave nueva. Es un script de UNA
 * sola corrida, manual — no se ejecuta como parte del deploy normal (no lo
 * llama railway.json ni migrate.ts).
 *
 * ORDEN OBLIGATORIO:
 *   1. Correr este script con CONFIRM=1 (con la variable ENCRYPTION_KEY de
 *      Railway TODAVÍA en el valor viejo — así el resto de la app sigue
 *      funcionando mientras migra).
 *   2. Recién cuando termine OK, cambiar ENCRYPTION_KEY en Railway al valor
 *      nuevo y dejar que redeploye.
 * Si se invierte el orden, la app queda sin poder leer estos datos hasta
 * que se corra el script. Igual que la rotación de filas, esto NO es
 * idempotente: correrlo dos veces sobre filas ya migradas falla al intentar
 * descifrarlas con la clave vieja (se loguea como fila fallida, no corrompe nada).
 *
 * Uso (sin CONFIRM=1 solo cuenta filas, no escribe nada):
 *   DATABASE_URL=<la de producción> \
 *   OLD_ENCRYPTION_KEY=<clave vieja, 64 hex> \
 *   NEW_ENCRYPTION_KEY=<clave nueva, 64 hex> \
 *   SUPABASE_URL=<la de producción> \
 *   SUPABASE_SERVICE_ROLE_KEY=<service role, no anon> \
 *   [SUPABASE_STORAGE_BUCKET=media] \
 *   [CONFIRM=1] npx tsx src/db/rotarClaveCifrado.ts
 */
import { Pool } from 'pg';
import crypto from 'crypto';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CA } from '../config/supabaseCa';

const ALGO = 'aes-256-gcm';

function keyFromHex(hex: string | undefined, nombre: string): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${nombre} debe ser 64 caracteres hex (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

function encryptWith(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptWith(key: Buffer, ciphertext: string): string {
  const [ivB64, tagB64, dataB64] = ciphertext.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function blindIndexWith(key: Buffer, value: string): string {
  const hmacKey = crypto.createHmac('sha256', key).update('blind-index-v1').digest();
  return crypto.createHmac('sha256', hmacKey).update(value.trim()).digest('hex');
}

/** Igual formato que crypto.service.ts encryptBuffer(): [iv(12)][tag(16)][ciphertext]. */
function encryptBufferWith(key: Buffer, data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function decryptBufferWith(key: Buffer, data: Buffer): Buffer {
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/**
 * Descarga un archivo del bucket, lo descifra con la clave vieja y lo vuelve
 * a subir cifrado con la nueva. `rutaPlana` es la ruta ya descifrada (con la
 * clave vieja) tal como se guardó originalmente, ej. "comprobantes/xxx.jpg";
 * se reconstruye con basename() + prefijo conocido, igual criterio anti path
 * traversal que pagos.routes.ts.
 */
async function rotarArchivoStorage(
  supabase: SupabaseClient,
  bucket: string,
  rutaPlana: string,
  prefijo: 'comprobantes' | 'facturas',
  oldKey: Buffer,
  newKey: Buffer,
): Promise<void> {
  const ruta = `${prefijo}/${path.basename(rutaPlana)}`;
  const { data, error } = await supabase.storage.from(bucket).download(ruta);
  if (error) throw new Error(`descargando ${ruta}: ${error.message}`);
  const cifradoViejo = Buffer.from(await data.arrayBuffer());
  const plano = decryptBufferWith(oldKey, cifradoViejo);
  const cifradoNuevo = encryptBufferWith(newKey, plano);
  const { error: upError } = await supabase.storage
    .from(bucket)
    .upload(ruta, cifradoNuevo, { contentType: 'application/octet-stream', upsert: true });
  if (upError) throw new Error(`subiendo ${ruta}: ${upError.message}`);
}

async function migrarTabla<T extends { id: string }>(
  pool: Pool,
  nombre: string,
  filas: T[],
  migrarFila: (fila: T) => Promise<void>,
  confirmar: boolean,
): Promise<void> {
  if (!confirmar) {
    console.log(`(dry-run) ${nombre}: ${filas.length} filas para re-cifrar`);
    return;
  }
  let ok = 0;
  let fallidas = 0;
  for (const fila of filas) {
    try {
      await migrarFila(fila);
      ok++;
    } catch (e: any) {
      fallidas++;
      console.error(`  ✖ ${nombre} id=${fila.id}: ${e.message}`);
    }
  }
  console.log(`✔ ${nombre}: ${ok} re-cifradas, ${fallidas} fallidas`);
}

async function main() {
  const oldKey = keyFromHex(process.env.OLD_ENCRYPTION_KEY, 'OLD_ENCRYPTION_KEY');
  const newKey = keyFromHex(process.env.NEW_ENCRYPTION_KEY, 'NEW_ENCRYPTION_KEY');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Falta DATABASE_URL');
  const confirmar = process.env.CONFIRM === '1';

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('supabase.co')
      ? { rejectUnauthorized: true, ca: SUPABASE_CA }
      : { rejectUnauthorized: true },
  });

  // Cliente de Storage para re-encriptar el binario de comprobantes/facturas.
  // Si no están seteadas, el script igual corre (dry-run siempre funciona;
  // en CONFIRM=1 falla recién al llegar a una fila que necesite storage).
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'media';
  const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

  if (!confirmar) console.log('--- DRY RUN (no se escribe nada; correr con CONFIRM=1 para aplicar) ---');
  if (confirmar && !supabase) {
    console.warn('⚠ Faltan SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY: no se va a poder rotar el contenido del storage.');
  }

  const choferes = await pool.query<{ id: string; dni_enc: string }>(
    'SELECT id, dni_enc FROM choferes WHERE dni_enc IS NOT NULL',
  );
  await migrarTabla(pool, 'choferes', choferes.rows, async (c) => {
    const dni = decryptWith(oldKey, c.dni_enc);
    await pool.query('UPDATE choferes SET dni_enc = $1, dni_hash = $2 WHERE id = $3', [
      encryptWith(newKey, dni),
      blindIndexWith(newKey, dni),
      c.id,
    ]);
  }, confirmar);

  const pagos = await pool.query<{ id: string; url_comprobante: string | null; factura_url: string | null }>(
    'SELECT id, url_comprobante, factura_url FROM pagos WHERE url_comprobante IS NOT NULL OR factura_url IS NOT NULL',
  );

  // 1) Contenido binario en el storage: hace falta la ruta con la clave
  //    VIEJA (p.url_comprobante tal como está en `pagos.rows`, sin tocar) —
  //    por eso corre antes de re-cifrar las referencias en la DB.
  await migrarTabla(pool, 'pagos (binario en storage)', pagos.rows, async (p) => {
    if (!supabase) throw new Error('Falta configurar Supabase Storage (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    if (p.url_comprobante) {
      await rotarArchivoStorage(supabase, bucket, decryptWith(oldKey, p.url_comprobante), 'comprobantes', oldKey, newKey);
    }
    if (p.factura_url) {
      await rotarArchivoStorage(supabase, bucket, decryptWith(oldKey, p.factura_url), 'facturas', oldKey, newKey);
    }
  }, confirmar);

  // 2) Referencia (ruta cifrada) en la DB.
  await migrarTabla(pool, 'pagos (referencias)', pagos.rows, async (p) => {
    const nuevoComprobante = p.url_comprobante ? encryptWith(newKey, decryptWith(oldKey, p.url_comprobante)) : null;
    const nuevaFactura = p.factura_url ? encryptWith(newKey, decryptWith(oldKey, p.factura_url)) : null;
    await pool.query('UPDATE pagos SET url_comprobante = $1, factura_url = $2 WHERE id = $3', [
      nuevoComprobante,
      nuevaFactura,
      p.id,
    ]);
  }, confirmar);

  // Comprobantes adicionales de la misma solicitud (llegan si el cliente
  // reenvía el pago de una cotización que ya tenía uno pendiente — sección
  // 23 —, ver pago.flow.ts). Mismo criterio que pagos: binario primero, referencia después.
  const adjuntos = await pool.query<{ id: string; url_comprobante: string }>(
    'SELECT id, url_comprobante FROM pagos_adjuntos WHERE url_comprobante IS NOT NULL',
  );
  await migrarTabla(pool, 'pagos_adjuntos (binario en storage)', adjuntos.rows, async (a) => {
    if (!supabase) throw new Error('Falta configurar Supabase Storage (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    await rotarArchivoStorage(supabase, bucket, decryptWith(oldKey, a.url_comprobante), 'comprobantes', oldKey, newKey);
  }, confirmar);
  await migrarTabla(pool, 'pagos_adjuntos (referencias)', adjuntos.rows, async (a) => {
    await pool.query('UPDATE pagos_adjuntos SET url_comprobante = $1 WHERE id = $2', [
      encryptWith(newKey, decryptWith(oldKey, a.url_comprobante)),
      a.id,
    ]);
  }, confirmar);

  const usuarios = await pool.query<{ id: string; mfa_secret_enc: string }>(
    'SELECT id, mfa_secret_enc FROM usuarios WHERE mfa_secret_enc IS NOT NULL',
  );
  await migrarTabla(pool, 'usuarios (MFA)', usuarios.rows, async (u) => {
    const secreto = decryptWith(oldKey, u.mfa_secret_enc);
    await pool.query('UPDATE usuarios SET mfa_secret_enc = $1 WHERE id = $2', [encryptWith(newKey, secreto), u.id]);
  }, confirmar);

  await pool.end();
  if (confirmar) {
    console.log('✔ Listo. Ahora sí podés cambiar ENCRYPTION_KEY en Railway al valor nuevo.');
  }
}

main().catch((e) => {
  console.error('✖ Error rotando la clave:', e);
  process.exit(1);
});
