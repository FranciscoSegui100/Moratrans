import { query } from '../../config/db';

export interface Sesion {
  telefono: string;
  flujo: string | null;
  paso: string | null;
  contexto: Record<string, any>;
}

// Minutos de inactividad tras los cuales la sesión se considera vencida (sección 22).
// Tope de seguridad pasivo: coincide con el cierre activo del cron de
// inactividad (aviso a los 5 min + cierre a los 5 min de ese aviso, ver
// jobs/inactividadChat.cron.ts). Si el cron ya cerró el chat, esto no hace
// nada (la fila ya no existe); si por algún motivo no llegó a correr, este
// TTL igual descarta la sesión vencida cuando el cliente vuelve a escribir.
const SESION_TTL_MIN = 10;

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

/**
 * Upsert de la sesión. Cada actividad real del cliente resetea `avisado_en`
 * a NULL: si ya se había mandado el aviso de "se va a cerrar el chat" pero el
 * cliente respondió antes de que se cerrara, el cron de inactividad tiene que
 * volver a contar los 5 min desde esta actividad, no desde el aviso viejo.
 * También resetea `intentos_invalidos` a 0: llegar acá significa que la
 * respuesta SÍ era válida para el estado actual (ver registrarIntentoInvalido).
 */
export async function setSesion(s: Sesion): Promise<void> {
  await query(
    `INSERT INTO sesiones_chat (telefono, flujo, paso, contexto, actualizado_en, avisado_en)
     VALUES ($1,$2,$3,$4, now(), NULL)
     ON CONFLICT (telefono) DO UPDATE
       SET flujo = EXCLUDED.flujo,
           paso = EXCLUDED.paso,
           contexto = EXCLUDED.contexto,
           actualizado_en = now(),
           avisado_en = NULL,
           intentos_invalidos = 0`,
    [s.telefono, s.flujo, s.paso, JSON.stringify(s.contexto)],
  );
}

/** Limpia la sesión (fin de flujo). */
export async function clearSesion(telefono: string): Promise<void> {
  await query('DELETE FROM sesiones_chat WHERE telefono = $1', [telefono]);
}

/**
 * Suma 1 a `intentos_invalidos` (respuesta que no corresponde al estado
 * actual) y devuelve el contador ya actualizado. No toca flujo/paso/contexto
 * — el cliente sigue en el mismo estado, solo cambia cuántas veces seguidas
 * le erró. Usado por estados.ts::manejarRespuestaInvalida. `setSesion`
 * resetea este contador a 0 en cualquier transición válida.
 */
export async function registrarIntentoInvalido(telefono: string): Promise<number> {
  const rows = await query<{ intentos_invalidos: number }>(
    `INSERT INTO sesiones_chat (telefono, intentos_invalidos)
     VALUES ($1, 1)
     ON CONFLICT (telefono) DO UPDATE
       SET intentos_invalidos = sesiones_chat.intentos_invalidos + 1
     RETURNING intentos_invalidos`,
    [telefono],
  );
  return rows[0].intentos_invalidos;
}
