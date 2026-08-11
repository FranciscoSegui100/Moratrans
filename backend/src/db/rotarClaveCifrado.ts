/**
 * Rotación de ENCRYPTION_KEY: descifra con la clave vieja lo que ya está
 * guardado (DNI de choferes, comprobantes/facturas, secreto TOTP de MFA) y
 * lo vuelve a cifrar/indexar con la nueva. Es un script de UNA sola corrida,
 * manual — no se ejecuta como parte del deploy normal (no lo llama
 * railway.json ni migrate.ts).
 *
 * ORDEN OBLIGATORIO:
 *   1. Correr este script con CONFIRM=1 (con la variable ENCRYPTION_KEY de
 *      Railway TODAVÍA en el valor viejo — así el resto de la app sigue
 *      funcionando mientras migra).
 *   2. Recién cuando termine OK, cambiar ENCRYPTION_KEY en Railway al valor
 *      nuevo y dejar que redeploye.
 * Si se invierte el orden, la app queda sin poder leer estos datos hasta
 * que se corra el script.
 *
 * Uso (sin CONFIRM=1 solo cuenta filas, no escribe nada):
 *   DATABASE_URL=<la de producción> \
 *   OLD_ENCRYPTION_KEY=<clave vieja, 64 hex> \
 *   NEW_ENCRYPTION_KEY=<clave nueva, 64 hex> \
 *   [CONFIRM=1] npx tsx src/db/rotarClaveCifrado.ts
 */
import { Pool } from 'pg';
import crypto from 'crypto';
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

  if (!confirmar) console.log('--- DRY RUN (no se escribe nada; correr con CONFIRM=1 para aplicar) ---');

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
  await migrarTabla(pool, 'pagos', pagos.rows, async (p) => {
    const nuevoComprobante = p.url_comprobante ? encryptWith(newKey, decryptWith(oldKey, p.url_comprobante)) : null;
    const nuevaFactura = p.factura_url ? encryptWith(newKey, decryptWith(oldKey, p.factura_url)) : null;
    await pool.query('UPDATE pagos SET url_comprobante = $1, factura_url = $2 WHERE id = $3', [
      nuevoComprobante,
      nuevaFactura,
      p.id,
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
