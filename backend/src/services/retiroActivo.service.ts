import { PoolClient } from 'pg';

export interface RetiroActivo {
  id: string;
  estado: 'programado' | 'en_curso';
  /** No null = esta fila ya es la mitad "retiro" de un recambio en curso (ver grupo_id en schema.sql). */
  grupo_id: string | null;
}

/**
 * Retiro 'programado' o 'en_curso' que ya existe para este contenedor, si
 * hay alguno — típicamente el automático por vencimiento (ver
 * jobs/alertas.cron.ts) o uno ya cargado a mano antes. `ux_viajes_activo_por_tipo`
 * garantiza que nunca hay más de uno a la vez, así que el LIMIT 1 nunca
 * descarta otro candidato real.
 *
 * Mismo criterio que ya usaban (cada uno con su propia copia de esta query)
 * pedirRetiro.flow.ts, recambio.flow.ts y viajes.routes.ts POST / —
 * centralizado acá para no seguir repitiéndolo cada vez que hace falta
 * "reprogramar en vez de duplicar".
 */
export async function buscarRetiroActivo(c: PoolClient, contenedorNumero: string): Promise<RetiroActivo | null> {
  const { rows } = await c.query<RetiroActivo>(
    `SELECT id, estado, grupo_id FROM viajes
      WHERE contenedor_numero = $1 AND tipo = 'retiro' AND estado IN ('programado', 'en_curso')
      ORDER BY creado_en DESC LIMIT 1`,
    [contenedorNumero],
  );
  return rows[0] ?? null;
}
