import { Pool, PoolClient } from 'pg';
import { env } from './env';
import { SUPABASE_CA } from './supabaseCa';

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
  // Sin esto, una conexión que se cae en silencio (ej. un proxy/NAT que
  // cierra el socket TCP sin avisar) queda "viva" para `pg` pero muerta en
  // los hechos: nunca tira error, nunca se libera, y una vez que las 10 del
  // pool quedan así, TODO lo que dependa de la DB (o sea, casi todo el bot)
  // se cuelga para siempre sin ningún log de error — el proceso sigue de
  // pie, pero deja de responder. keepAlive detecta el socket muerto a nivel
  // TCP; connectionTimeoutMillis evita esperar para siempre por un lugar
  // libre; statement_timeout/query_timeout cortan una query colgada en vez
  // de dejarla retener su conexión indefinidamente.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
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
