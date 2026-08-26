/**
 * Script de prueba puntual: carga viajes de prueba en la bolsa de rutas
 * (atrasado/hoy/mañana) y contenedores de prueba con vence_en en distintos
 * estados (vencido/por vencer/futuro) para verificar a ojo el fix de fechas
 * de b2c1a46 + 4bc8783. NO se registra en package.json a propósito: es
 * desechable, correr con `tsx src/db/seedTestVencimientos.ts` y borrar
 * después con `tsx src/db/seedTestVencimientos.ts --clean`.
 */
import { Pool } from 'pg';
import { env } from '../config/env';
import { SUPABASE_CA } from '../config/supabaseCa';

// Pool minimalista (sin statement_timeout/keepalive): contra el pooler de
// Supabase en modo transacción (pgbouncer=true, puerto 6543) esos parámetros
// de sesión rompen la conexión ("unsupported startup parameter").
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_URL.includes('supabase.co')
    ? { rejectUnauthorized: true, ca: SUPABASE_CA }
    : { rejectUnauthorized: true },
});
async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

const PREFIJO = 'TEST-VENC-';

async function limpiar() {
  await query(`DELETE FROM viajes WHERE notas LIKE $1`, [`${PREFIJO}%`]);
  await query(`DELETE FROM contenedores WHERE numero LIKE $1`, [`${PREFIJO}%`]);
  console.log('Datos de prueba borrados.');
}

async function sembrar() {
  // --- Bolsa de rutas: viajes sin ruta_id, distintas fechas ---
  const viajes = [
    { offset: -2, nota: 'atrasado 2 días' },
    { offset: -1, nota: 'atrasado 1 día' },
    { offset: 0, nota: 'para hoy' },
    { offset: 1, nota: 'para mañana' },
  ];

  for (const v of viajes) {
    await query(
      `INSERT INTO viajes (tipo, fecha, zona, destino_direccion, horario_preferido, cliente_telefono, notas)
       VALUES ('entrega', (CURRENT_DATE + ($1 || ' days')::interval)::date, 'Montevideo', $2, '🌅 Mañana (8 a 12hs)', '000000000', $3)`,
      [v.offset, `Dirección de prueba (${v.nota})`, `${PREFIJO}${v.nota}`],
    );
    console.log(`Viaje "${v.nota}" -> fecha offset ${v.offset}d`);
  }

  // --- Contenedores: vence_en en distintos estados ---
  const contenedores = [
    { numero: `${PREFIJO}VENCIDO1`, horas: -30, nota: 'vencido hace 30hs' },
    { numero: `${PREFIJO}PORVENCER`, horas: 20, nota: 'vence en 20hs (dentro de la ventana de 48hs)' },
    { numero: `${PREFIJO}HOY`, horas: 3, nota: 'vence en 3hs (hoy)' },
    { numero: `${PREFIJO}FUTURO`, horas: 24 * 7, nota: 'vence en 7 días' },
  ];

  for (const c of contenedores) {
    await query(
      `INSERT INTO contenedores (numero, estado, vence_en, actualizado_por)
       VALUES ($1, 'entregado', now() + ($2 || ' hours')::interval, 'sistema:test')`,
      [c.numero, c.horas],
    );
    console.log(`Contenedor ${c.numero} -> ${c.nota}`);
  }

  console.log('Listo. Viajes y contenedores de prueba cargados.');
}

async function main() {
  if (process.argv.includes('--clean')) {
    await limpiar();
  } else {
    await sembrar();
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
