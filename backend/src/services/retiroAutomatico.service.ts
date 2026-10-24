import { query } from '../config/db';
import { emitRecursoActualizado } from '../config/socket';
import { diaHabilDesde } from './diasHabiles.service';
import { resolverUbicacion } from './ubicaciones.service';

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

/**
 * Cada contenedor entregado con `vence_en` y sin ningún retiro activo
 * recibe su retiro automático en la bolsa del día que vence, o del lunes si
 * vence sábado/domingo (diaHabilDesde). Un retiro que ya existe no se toca,
 * ni siquiera su fecha: puede haberla movido el cliente (retiro anticipado,
 * pedirRetiro.flow.ts) o un operador. Un cambio de vencimiento ya mueve o
 * recrea el retiro por su cuenta (alargue: ver cancelarRetiroAutomatico).
 *
 * La corre el cron cada 15 minutos (jobs/alertas.cron.ts) y también GET
 * /api/rutas/bolsa antes de listar — así un vencimiento recién cargado o
 * cambiado se ve al toque en la bolsa, sin esperar al cron.
 */
export async function sincronizarRetirosPorVencimiento(): Promise<void> {
  // vence_fecha en hora Mendoza (UTC-3, sin horario de verano): mismo
  // criterio que hoyMendozaISO, sin depender de la zona del server ni de la
  // de Postgres.
  const contenedores = await query<{
    numero: string;
    vence_fecha: string;
    cliente_telefono: string | null;
    zona: string | null;
    destino_direccion: string | null;
    destino_lat: number | null;
    destino_lng: number | null;
  }>(
    `SELECT c.numero,
            to_char((c.vence_en - interval '3 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS vence_fecha,
            ultima.cliente_telefono, ultima.zona, ultima.destino_direccion,
            ultima.destino_lat, ultima.destino_lng
       FROM contenedores c
       LEFT JOIN LATERAL (
         SELECT v.cliente_telefono, v.zona, v.destino_direccion, v.destino_lat, v.destino_lng
           FROM viajes v
          WHERE v.contenedor_numero = c.numero AND v.tipo = 'entrega' AND v.estado <> 'cancelado'
          ORDER BY v.creado_en DESC LIMIT 1
       ) ultima ON true
      WHERE c.estado = 'entregado' AND c.vence_en IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM viajes v2
           WHERE v2.contenedor_numero = c.numero AND v2.tipo = 'retiro' AND v2.estado IN ('programado', 'en_curso')
        )`,
  );

  if (contenedores.length === 0) return;
  const vaciadero = await resolverUbicacion('vaciadero');
  let creados = 0;
  for (const c of contenedores) {
    // ON CONFLICT: si justo lo creó otra corrida (cron y bolsa a la vez), el
    // índice único de un retiro activo por contenedor lo frena sin error.
    const rows = await query(
      `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, notas, ubicacion_id, ubicacion_direccion)
       VALUES ('retiro', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [diaHabilDesde(c.vence_fecha), c.numero, c.cliente_telefono, c.zona, c.destino_direccion, c.destino_lat, c.destino_lng,
       NOTA_RETIRO_AUTOMATICO, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
    );
    creados += rows.length;
  }
  if (creados > 0) {
    emitRecursoActualizado('viajes');
    console.log(`[retiros] ${creados} retiro(s) automático(s) agregado(s) a la bolsa por vencimiento`);
  }
}
