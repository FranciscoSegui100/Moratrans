/**
 * Carga el/los chofer(es) inicial(es) cifrando el DNI en la app.
 * Uso:  npm run db:seed-choferes
 */
import { pool, query } from '../config/db';
import { encrypt, blindIndex } from '../services/crypto.service';

const choferesIniciales = [
  { nombre: 'Juan Pérez', dni: '48123456', telefono: '59899111222' },
];

async function main() {
  for (const c of choferesIniciales) {
    await query(
      `INSERT INTO choferes (nombre, dni_enc, dni_hash, telefono)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (dni_hash) DO NOTHING`,
      [c.nombre, encrypt(c.dni), blindIndex(c.dni), c.telefono],
    );
    console.log(`✔ chofer cargado: ${c.nombre}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
