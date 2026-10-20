import { query } from '../config/db';
import { emitRecursoActualizado } from '../config/socket';

/**
 * Marca de los retiros que crea solo el cron de alertas (ver
 * jobs/alertas.cron.ts) — así se distinguen de uno que pidió el cliente o
 * cargó un operador, que nunca se tocan desde acá.
 */
export const NOTA_RETIRO_AUTOMATICO = 'Retiro automático por vencimiento de plazo';

/**
 * El cliente extendió el alquiler: el retiro automático que ya había entrado
 * a la bolsa (o a una ruta, sin salir todavía) deja de tener sentido. Se
 * cancela y se saca de la ruta; el cron lo vuelve a crear solo el día hábil
 * anterior al nuevo vencimiento. Los recambios (grupo_id) no se tocan.
 */
export async function cancelarRetiroAutomatico(contenedorNumero: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE viajes
        SET estado = 'cancelado', ruta_id = NULL, orden = NULL
      WHERE contenedor_numero = $1
        AND tipo = 'retiro'
        AND estado = 'programado'
        AND grupo_id IS NULL
        AND notas = $2
      RETURNING id`,
    [contenedorNumero, NOTA_RETIRO_AUTOMATICO],
  );
  if (rows.length > 0) emitRecursoActualizado('viajes');
  return rows.length;
}
