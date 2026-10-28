import { query, withTx } from '../config/db';
import { emitAlerta, emitRecursoActualizado } from '../config/socket';
import { DIAS_ALQUILER_ANTES_RETIRO } from '../config/bot.config';

/**
 * Flujo de entrega: el contenedor NO se elige al armar la ruta ni al validar
 * el pago — lo elige el chofer en el momento en que toca "📦 Ya entregué"
 * (ver chofer.flow.ts), de la lista de contenedores disponibles en ese
 * momento. La empresa no lleva un control fino de qué vacío sube a cada
 * camión, así que asignarlo antes era adivinar.
 */

export interface ContenedorDisponible {
  numero: string;
  tamano: number | null;
}

/** "C-014 (7 m³)" — cómo se le muestra un contenedor al chofer y al panel. */
export function etiquetaContenedor(numero: string, tamano: number | null): string {
  return tamano ? `${numero} (${tamano} m³)` : numero;
}

/**
 * Contenedores que se pueden entregar ahora mismo: en depósito ('disponible')
 * y sin otra entrega activa que ya los tenga (un vacío preasignado por el
 * flujo viejo, o uno que otro chofer eligió hace un instante).
 */
export async function contenedoresDisponiblesParaEntregar(tamano?: number | null): Promise<ContenedorDisponible[]> {
  const params: unknown[] = [];
  let filtroTamano = '';
  if (tamano !== undefined) {
    if (tamano === null) {
      filtroTamano = 'AND c.tamano IS NULL';
    } else {
      params.push(tamano);
      filtroTamano = `AND c.tamano = $${params.length}`;
    }
  }
  return query<ContenedorDisponible>(
    `SELECT c.numero, c.tamano
       FROM contenedores c
      WHERE c.estado = 'disponible' ${filtroTamano}
        AND NOT EXISTS (
          SELECT 1 FROM viajes v
           WHERE v.contenedor_numero = c.numero AND v.tipo = 'entrega' AND v.estado IN ('programado', 'en_curso')
        )
      ORDER BY c.tamano NULLS LAST, c.numero`,
    params,
  );
}

export type ResultadoAsignacion =
  | {
      ok: true;
      numero: string;
      tamano: number | null;
      viaje: { id: string; cliente_telefono: string | null; grupo_id: string | null; destino_direccion: string | null };
    }
  | { ok: false; motivo: 'viaje_invalido' | 'ya_entregada' | 'no_disponible'; estadoActual?: string };

/**
 * El chofer eligió con qué contenedor completó la entrega `viajeId`: en una
 * sola transacción lo deja 'entregado' a ese cliente (con el vencimiento
 * contado desde ahora, igual que cualquier entrega), lo graba en el viaje y
 * levanta la alerta para el panel. Bloquea el contenedor (FOR UPDATE) para
 * que dos choferes no puedan elegir el mismo a la vez.
 *
 * Solo acepta contenedores disponibles (decisión del negocio: si el que dejó
 * no figura disponible, que avise a la oficina en vez de registrar algo
 * dudoso). Excepción: una entrega del flujo viejo que ya traía su contenedor
 * reservado se completa con ese mismo.
 */
export async function asignarContenedorAEntrega(params: {
  viajeId: string;
  numero: string;
  choferId: string;
  choferNombre: string;
}): Promise<ResultadoAsignacion> {
  const { viajeId, numero, choferId, choferNombre } = params;

  const resultado = await withTx(async (c) => {
    const { rows: viajes } = await c.query<{
      id: string; tipo: string; estado: string; chofer_id: string | null; contenedor_numero: string | null;
      completada_en: string | null; cliente_telefono: string | null; grupo_id: string | null; destino_direccion: string | null;
    }>(
      `SELECT id, tipo, estado, chofer_id, contenedor_numero, completada_en, cliente_telefono, grupo_id, destino_direccion
         FROM viajes WHERE id = $1 FOR UPDATE`,
      [viajeId],
    );
    const viaje = viajes[0];
    if (!viaje || viaje.tipo !== 'entrega' || !['programado', 'en_curso'].includes(viaje.estado)) {
      return { ok: false as const, motivo: 'viaje_invalido' as const };
    }
    if (viaje.completada_en) return { ok: false as const, motivo: 'ya_entregada' as const };

    // Tiene que ser una entrega de ESTE chofer — o, en un recambio todavía
    // sin chofer en la pata de entrega, que el retiro pareja sea suyo.
    let esSuya = viaje.chofer_id === choferId;
    if (!esSuya && !viaje.chofer_id && viaje.grupo_id) {
      const { rows } = await c.query(
        `SELECT 1 FROM viajes WHERE grupo_id = $1 AND tipo = 'retiro' AND chofer_id = $2 LIMIT 1`,
        [viaje.grupo_id, choferId],
      );
      esSuya = rows.length > 0;
    }
    if (!esSuya) return { ok: false as const, motivo: 'viaje_invalido' as const };

    // Una entrega del flujo viejo que ya traía otro contenedor: no se cambia acá.
    if (viaje.contenedor_numero && viaje.contenedor_numero.toUpperCase() !== numero.toUpperCase()) {
      return { ok: false as const, motivo: 'viaje_invalido' as const };
    }

    const { rows: conts } = await c.query<{ numero: string; estado: string; tamano: number | null }>(
      `SELECT numero, estado, tamano FROM contenedores WHERE UPPER(numero) = UPPER($1) FOR UPDATE`,
      [numero],
    );
    const cont = conts[0];
    if (!cont) return { ok: false as const, motivo: 'no_disponible' as const };

    const reservadoParaEsta = cont.estado === 'reservado' && viaje.contenedor_numero?.toUpperCase() === cont.numero.toUpperCase();
    if (cont.estado !== 'disponible' && !reservadoParaEsta) {
      return { ok: false as const, motivo: 'no_disponible' as const, estadoActual: cont.estado };
    }
    const { rows: ocupado } = await c.query(
      `SELECT 1 FROM viajes
        WHERE contenedor_numero = $1 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso') AND id <> $2
        LIMIT 1`,
      [cont.numero, viaje.id],
    );
    if (ocupado.length > 0) return { ok: false as const, motivo: 'no_disponible' as const, estadoActual: 'elegido para otra entrega' };

    const actualizadoPor = `chofer:${choferId}`;
    // El trigger fn_validar_transicion_contenedor no permite disponible ->
    // entregado directo: se pasa por 'reservado' (queda auditado igual).
    if (cont.estado === 'disponible') {
      await c.query(`UPDATE contenedores SET estado = 'reservado', actualizado_por = $2 WHERE numero = $1`, [cont.numero, actualizadoPor]);
    }
    await c.query(
      `UPDATE contenedores SET estado = 'entregado', vence_en = fn_vencimiento_habil(now(), $2), actualizado_por = $3
        WHERE numero = $1`,
      [cont.numero, DIAS_ALQUILER_ANTES_RETIRO, actualizadoPor],
    );
    const { rows: choferRows } = await c.query<{ patente: string | null }>('SELECT patente FROM choferes WHERE id = $1', [choferId]);
    await c.query(
      `UPDATE viajes SET contenedor_numero = $2, completada_en = now(),
              chofer_id = COALESCE(chofer_id, $3), patente = COALESCE(patente, $4)
        WHERE id = $1`,
      [viaje.id, cont.numero, choferId, choferRows[0]?.patente ?? null],
    );

    const { rows: clienteRows } = await c.query<{ nombre: string | null }>(
      'SELECT nombre FROM clientes WHERE telefono = $1',
      [viaje.cliente_telefono],
    );
    const cliente = clienteRows[0]?.nombre && clienteRows[0].nombre !== 'Sin nombre' ? clienteRows[0].nombre : viaje.cliente_telefono;
    const { rows: alertas } = await c.query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('contenedor_entregado', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [
        viaje.id,
        `${choferNombre} entregó el ${etiquetaContenedor(cont.numero, cont.tamano)}${viaje.grupo_id ? ' (recambio)' : ''}` +
          `${cliente ? ` a ${cliente}` : ''}${viaje.destino_direccion ? ` — ${viaje.destino_direccion}` : ''}`,
      ],
    );

    return {
      ok: true as const,
      numero: cont.numero,
      tamano: cont.tamano,
      viaje: { id: viaje.id, cliente_telefono: viaje.cliente_telefono, grupo_id: viaje.grupo_id, destino_direccion: viaje.destino_direccion },
      alerta: alertas[0] as unknown,
    };
  });

  if (!resultado.ok) return resultado;
  if (resultado.alerta) emitAlerta({ ...(resultado.alerta as object), cliente_telefono: resultado.viaje.cliente_telefono });
  emitRecursoActualizado('contenedores');
  emitRecursoActualizado('viajes');
  const { alerta: _alerta, ...resto } = resultado;
  return resto;
}

export type ResultadoCambio = { ok: true; anterior: string; nuevo: string } | { ok: false; error: string };

/**
 * La oficina corrige el contenedor de una entrega YA hecha (el chofer eligió
 * mal): el equivocado vuelve a 'disponible' y el correcto queda 'entregado'
 * con el MISMO vencimiento. Si ya había un retiro programado para el
 * equivocado (el automático por vencimiento, o uno pedido), pasa al correcto.
 */
export async function cambiarContenedorDeEntrega(params: {
  viajeId: string;
  nuevoNumero: string;
  actualizadoPor: string;
}): Promise<ResultadoCambio> {
  const { viajeId, nuevoNumero, actualizadoPor } = params;
  const r = await withTx(async (c): Promise<ResultadoCambio> => {
    const { rows: viajes } = await c.query<{ tipo: string; estado: string; contenedor_numero: string | null; completada_en: string | null }>(
      'SELECT tipo, estado, contenedor_numero, completada_en FROM viajes WHERE id = $1 FOR UPDATE',
      [viajeId],
    );
    const viaje = viajes[0];
    if (!viaje || viaje.tipo !== 'entrega') return { ok: false, error: 'Ese viaje no es una entrega.' };
    if (!viaje.completada_en || !viaje.contenedor_numero) {
      return { ok: false, error: 'Esta entrega todavía no se hizo: el contenedor lo elige el chofer al entregar.' };
    }
    if (viaje.estado === 'completado') {
      return { ok: false, error: 'El ciclo de esta entrega ya se cerró (el contenedor ya se retiró y vació).' };
    }
    const anterior = viaje.contenedor_numero;
    if (anterior.toUpperCase() === nuevoNumero.toUpperCase()) return { ok: false, error: 'Es el mismo contenedor.' };

    const { rows: conts } = await c.query<{ numero: string; estado: string; vence_en: Date | null }>(
      `SELECT numero, estado, vence_en FROM contenedores WHERE UPPER(numero) = ANY($1::text[]) FOR UPDATE`,
      [[anterior.toUpperCase(), nuevoNumero.toUpperCase()]],
    );
    const viejo = conts.find((x) => x.numero.toUpperCase() === anterior.toUpperCase());
    const nuevo = conts.find((x) => x.numero.toUpperCase() === nuevoNumero.toUpperCase());
    if (!nuevo) return { ok: false, error: `No existe el contenedor ${nuevoNumero}.` };
    if (nuevo.estado !== 'disponible') return { ok: false, error: `El ${nuevo.numero} no está disponible (figura ${nuevo.estado}).` };
    if (viejo?.estado !== 'entregado') {
      return { ok: false, error: `El ${anterior} ya no figura entregado (figura ${viejo?.estado ?? 'inexistente'}) — corregilo desde Contenedores.` };
    }
    const { rows: retiroEnCurso } = await c.query(
      `SELECT 1 FROM viajes WHERE contenedor_numero = $1 AND tipo = 'retiro' AND estado = 'en_curso' LIMIT 1`,
      [anterior],
    );
    if (retiroEnCurso.length > 0) return { ok: false, error: `El ${anterior} ya se está retirando — no se puede cambiar ahora.` };

    // Viejo: entregado -> retirado -> disponible (el trigger no permite saltar directo).
    await c.query(`UPDATE contenedores SET estado = 'retirado', actualizado_por = $2 WHERE numero = $1`, [viejo.numero, actualizadoPor]);
    await c.query(
      `UPDATE contenedores SET estado = 'disponible', vence_en = NULL, cliente_id = NULL, actualizado_por = $2 WHERE numero = $1`,
      [viejo.numero, actualizadoPor],
    );
    // Nuevo: disponible -> reservado -> entregado, con el vencimiento que ya tenía la entrega.
    await c.query(`UPDATE contenedores SET estado = 'reservado', actualizado_por = $2 WHERE numero = $1`, [nuevo.numero, actualizadoPor]);
    await c.query(
      `UPDATE contenedores SET estado = 'entregado', vence_en = $2, actualizado_por = $3 WHERE numero = $1`,
      [nuevo.numero, viejo.vence_en, actualizadoPor],
    );
    await c.query('UPDATE viajes SET contenedor_numero = $2 WHERE id = $1', [viajeId, nuevo.numero]);
    // Retiro ya programado del equivocado (automático o pedido): pasa al correcto.
    await c.query(
      `UPDATE viajes SET contenedor_numero = $2
        WHERE contenedor_numero = $1 AND tipo = 'retiro' AND estado = 'programado'`,
      [viejo.numero, nuevo.numero],
    );
    return { ok: true, anterior: viejo.numero, nuevo: nuevo.numero };
  });
  if (r.ok) {
    emitRecursoActualizado('contenedores');
    emitRecursoActualizado('viajes');
  }
  return r;
}
