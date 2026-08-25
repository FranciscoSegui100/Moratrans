import { PoolClient } from 'pg';

/** Mismo patrón que el resto del código: un error con `.status` que las rutas mapean a la respuesta HTTP. */
function fail(msg: string): never {
  const err: any = new Error(msg);
  err.status = 409;
  throw err;
}

/**
 * A lo sumo una reserva activa por contenedor. Si está disponible, se
 * reserva ya (misma transición que fn_validar_pago, disponible -> reservado).
 * Si está ocupado (con otro cliente), se permite reservarlo igual pero solo
 * para una fecha posterior a su vence_en (fecha de vuelta) — sin tocar su
 * estado actual todavía; el contenedor pasa a "reservado" recién cuando
 * efectivamente vuelve (ver POST /api/contenedores/:numero/confirmar-retiro).
 * Se usa tanto para una entrega suelta como para la pata "entrega" de un
 * recambio (ver viajes.routes.ts) y para confirmar una ruta (rutas.routes.ts).
 *
 * `opciones.liberadoPorRutaEnOrden`: cuando el contenedor lo libera la
 * PROPIA ruta que se está confirmando (retiro + vaciado en un orden anterior
 * de la misma ruta), `vence_en` es un dato ajeno a esa liberación — refleja
 * la vuelta estimada de una entrega a OTRO cliente, no el plan de esta ruta.
 * El llamador ya validó por simulación (`simularDisponibilidad`) que el
 * contenedor se libera antes en la secuencia, así que acá se bypasea el
 * chequeo de `vence_en` en vez de rechazar un caso válido.
 *
 * `opciones.excluirViajeId`: al confirmar una ruta, la parada de entrega ya
 * existe como fila de `viajes` con su `contenedor_numero` escrito desde el
 * armado (PATCH .../contenedor) — sin excluirla, el chequeo de "ya tiene una
 * entrega reservada" se auto-colisiona contra la propia fila que se está
 * confirmando. En el alta de un viaje nuevo (viajes.routes.ts) la fila
 * todavía no existe, así que ahí no hace falta pasar este parámetro.
 */
export async function reservarParaEntrega(
  c: PoolClient,
  numero: string,
  fecha: string,
  actualizadoPor: string,
  opciones?: { liberadoPorRutaEnOrden?: number; excluirViajeId?: string },
): Promise<void> {
  const { rows: contRows } = await c.query<{ estado: string; vence_en: string | null }>(
    'SELECT estado, vence_en FROM contenedores WHERE numero = $1 FOR UPDATE',
    [numero],
  );
  const cont = contRows[0];
  if (!cont) fail(`El contenedor ${numero} no existe.`);

  const { rows: activos } = await c.query(
    `SELECT id FROM viajes WHERE contenedor_numero = $1 AND tipo = 'entrega' AND estado IN ('programado','en_curso')
       AND ($2::uuid IS NULL OR id <> $2)`,
    [numero, opciones?.excluirViajeId ?? null],
  );
  if (activos.length > 0) {
    fail(`El contenedor ${numero} ya tiene una entrega reservada (actual o futura); no se puede reservar dos veces.`);
  }

  if (cont!.estado === 'disponible') {
    // La fecha de la entrega ES el vencimiento: cuándo se espera que este
    // contenedor vuelva una vez alquilado (no al programar el retiro — para
    // entonces la alerta de "por vencer" ya llegaría tarde).
    await c.query(
      `UPDATE contenedores SET estado = 'reservado', vence_en = $2::date, actualizado_por = $3
         WHERE numero = $1 AND estado = 'disponible'`,
      [numero, fecha, actualizadoPor],
    );
    return;
  }

  if (opciones?.liberadoPorRutaEnOrden !== undefined) {
    // La propia ruta lo libera antes en su secuencia — no se toca el estado
    // acá (sigue como esté hasta que el chofer ejecute de verdad esa parada),
    // y no se exige vence_en porque no aplica a este camino.
    return;
  }

  if (!cont!.vence_en) {
    fail(`El contenedor ${numero} está ${cont!.estado} y no tiene fecha de vuelta cargada; no se puede reservar a futuro.`);
  }
  const venceFecha = new Date(cont!.vence_en!).toISOString().slice(0, 10);
  if (fecha < venceFecha) {
    fail(`El contenedor ${numero} vuelve el ${new Date(cont!.vence_en!).toLocaleDateString('es-AR')}; elegí esa fecha o una posterior.`);
  }
  // Sigue "ocupado" hasta que vuelva de verdad — no se toca su estado acá.
}

/**
 * Simétrica de reservarParaEntrega: se llama al desconfirmar una parada de
 * entrega (se la desprende de una ruta ya confirmada, o se la mueve a otra —
 * ver rutas.routes.ts DELETE/mover) para no dejar el contenedor "reservado
 * fantasma": reservado en el sistema pero sin aparecer en ninguna ruta activa
 * coherente. Solo revierte contenedores.estado si esta reserva efectivamente
 * lo había sacado de 'disponible' — el otro camino de reservarParaEntrega (la
 * reserva "a futuro" sobre un contenedor todavía ocupado por otro cliente) no
 * toca estado, así que acá tampoco hay nada que revertir en ese caso.
 */
export async function liberarReservaEntrega(c: PoolClient, numero: string, actualizadoPor: string): Promise<void> {
  await c.query(
    `UPDATE contenedores SET estado = 'disponible', vence_en = NULL, actualizado_por = $2
       WHERE numero = $1 AND estado = 'reservado'`,
    [numero, actualizadoPor],
  );
}
