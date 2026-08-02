import { query } from '../../config/db';

export interface Sesion {
  telefono: string;
  flujo: string | null;
  paso: string | null;
  contexto: Record<string, any>;
}

// Minutos de inactividad tras los cuales la sesión se considera vencida (sección 22).
const SESION_TTL_MIN = 30;

/**
 * Devuelve la sesión (o una vacía) para un teléfono.
 * Si la última actividad supera SESION_TTL_MIN, se descarta y se resetea al menú.
 */
export async function getSesion(telefono: string): Promise<Sesion> {
  const rows = await query<Sesion & { vencida: boolean }>(
    `SELECT telefono, flujo, paso, contexto,
            (actualizado_en < now() - ($2 || ' minutes')::interval) AS vencida
       FROM sesiones_chat WHERE telefono = $1`,
    [telefono, String(SESION_TTL_MIN)],
  );
  const s = rows[0];
  if (!s) return { telefono, flujo: null, paso: null, contexto: {} };
  if (s.vencida) {
    await clearSesion(telefono);
    return { telefono, flujo: null, paso: null, contexto: {} };
  }
  return { telefono: s.telefono, flujo: s.flujo, paso: s.paso, contexto: s.contexto };
}

/** Upsert de la sesión. */
export async function setSesion(s: Sesion): Promise<void> {
  await query(
    `INSERT INTO sesiones_chat (telefono, flujo, paso, contexto, actualizado_en)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (telefono) DO UPDATE
       SET flujo = EXCLUDED.flujo,
           paso = EXCLUDED.paso,
           contexto = EXCLUDED.contexto,
           actualizado_en = now()`,
    [s.telefono, s.flujo, s.paso, JSON.stringify(s.contexto)],
  );
}

/** Limpia la sesión (fin de flujo). */
export async function clearSesion(telefono: string): Promise<void> {
  await query('DELETE FROM sesiones_chat WHERE telefono = $1', [telefono]);
}
