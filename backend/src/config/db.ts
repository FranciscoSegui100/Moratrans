import { Pool, PoolClient } from 'pg';
import { env } from './env';

// Pool único compartido por chatbot y panel: la DB es la única fuente de verdad.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  ssl: env.DATABASE_URL.includes('supabase.co') || env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
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
