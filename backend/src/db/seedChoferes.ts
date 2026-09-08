/**
 * Carga el/los chofer(es) inicial(es).
 * Uso:  npm run db:seed-choferes
 */
import { pool, query } from '../config/db';


const choferesIniciales = [
  { nombre: 'Juan Pérez', telefono: '59899111222' },
];

async function main() {
  for (const c of choferesIniciales) {
    await query(
      `INSERT INTO choferes (nombre, telefono) VALUES ($1,$2) ON CONFLICT (telefono) DO NOTHING`,
       [c.nombre, c.telefono],
    );
    console.log(`✔ chofer cargado: ${c.nombre}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
