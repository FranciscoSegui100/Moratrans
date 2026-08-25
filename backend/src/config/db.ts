import { Pool, PoolClient, types } from 'pg';
import { env } from './env';
import { SUPABASE_CA } from './supabaseCa';

// Parsear DATE (OID 1082) como string 'YYYY-MM-DD' en lugar de convertir a Date UTC
types.setTypeParser(1082, (val: string) => val);

const esSupabase = env.DATABASE_URL.includes('supabase.co');

// Pool único compartido por chatbot y panel: la DB es la única fuente de verdad.
// La conexión valida el certificado del servidor (rejectUnauthorized: true) en
// vez de aceptar cualquier certificado como antes: contra Supabase se pinea su
// CA raíz (self-signed, no está en el store de confianza por defecto de Node);
// contra cualquier otro host de producción se usa el store de confianza estándar.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  ssl: esSupabase
    ? { rejectUnauthorized: true, ca: SUPABASE_CA }
    : env.NODE_ENV === 'production'
      ? { rejectUnauthorized: true }
      : false,
});


pool.on('error', (err) => console.error('PG pool error:', err));

// Helper de query tipado
export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

// Helper transaccional
export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
