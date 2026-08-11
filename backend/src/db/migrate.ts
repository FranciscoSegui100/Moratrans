/**
 * Corre las migraciones de backend/src/db/migrations/ que todavía no se
 * aplicaron en esta base, en orden alfabético, cada una en su propia
 * transacción. Se ejecuta automáticamente al arrancar el servidor (ver
 * railway.json) para que un cambio de esquema nuevo nunca más dependa de
 * que alguien lo corra a mano en el SQL Editor de Supabase.
 *
 * Uso manual: npm run db:migrate
 */
import fs from 'fs';
import path from 'path';
import { pool } from '../config/db';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        aplicado_en TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const { rows: aplicadasRows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const aplicadas = new Set(aplicadasRows.map((r) => r.filename));

    const archivos = fs.existsSync(MIGRATIONS_DIR)
      ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
      : [];
    const pendientes = archivos.filter((f) => !aplicadas.has(f));

    if (pendientes.length === 0) {
      console.log('✔ Migraciones al día, nada para aplicar.');
      return;
    }

    for (const archivo of pendientes) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, archivo), 'utf-8');
      console.log(`→ Aplicando migración ${archivo}...`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [archivo]);
        await client.query('COMMIT');
        console.log(`✔ ${archivo} aplicada.`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${archivo}: ${(e as Error).message}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('✖ Error corriendo migraciones:', e.message ?? e);
  process.exit(1);
});
