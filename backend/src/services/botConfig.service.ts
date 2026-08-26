import { query } from '../config/db';

export interface EstadoBot {
  bot_activo: boolean;
  actualizado_en: string;
}

/** Estado actual del interruptor (fila única, ver migración 0036). */
export async function obtenerEstadoBot(): Promise<EstadoBot> {
  const [row] = await query<EstadoBot>('SELECT bot_activo, actualizado_en FROM configuracion_bot WHERE id = 1');
  return row ?? { bot_activo: true, actualizado_en: new Date().toISOString() };
}

/**
 * Se consulta en cada mensaje entrante de un cliente (ver
 * messageRouter.ts::enrutar) — no cachea: es una sola fila indexada por PK,
 * el costo es despreciable frente a cualquier otra consulta del flujo.
 */
export async function botEstaActivo(): Promise<boolean> {
  return (await obtenerEstadoBot()).bot_activo;
}

export async function establecerEstadoBot(activo: boolean, usuarioId: string): Promise<EstadoBot> {
  const [row] = await query<EstadoBot>(
    `UPDATE configuracion_bot SET bot_activo = $1, actualizado_por = $2, actualizado_en = now()
      WHERE id = 1 RETURNING bot_activo, actualizado_en`,
    [activo, usuarioId],
  );
  return row;
}
