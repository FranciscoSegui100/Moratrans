import type { PoolClient } from 'pg';
import { query, withTx } from '../config/db';
import { emitAlerta, emitAlertaActualizada, emitRecursoActualizado } from '../config/socket';
import { DIAS_ALQUILER_ANTES_RETIRO } from '../config/bot.config';

/**
 * Flujo de entrega: el contenedor NO se elige al armar la ruta ni al validar
 * el pago — lo elige el chofer en el momento en que toca "📦 Ya entregué"
 * (ver chofer.flow.ts): escribe el número del que dejó y lo confirma. La empresa no lleva un control fino de qué vacío sube a cada
 * camión, así que asignarlo antes era adivinar.
 */

/** "C-014 (7 m³)" — cómo se le muestra un contenedor al chofer y al panel. */
export function etiquetaContenedor(numero: string, tamano: number | null): string {
  return tamano ? `${numero} (${tamano} m³)` : numero;
}

type ViajeEntrega = {
  id: string; tipo: string; estado: string; chofer_id: string | null; contenedor_numero: string | null;
  completada_en: string | null; cliente_telefono: string | null; grupo_id: string | null; destino_direccion: string | null;
};

/**
 * Bloquea (FOR UPDATE) la entrega `viajeId` y chequea que el chofer la pueda
 * registrar: activa, todavía sin entregar y suya — o, en un recambio todavía
 * sin chofer en la pata de entrega, que el retiro pareja sea suyo.
 */
async function bloquearEntregaDelChofer(
  c: PoolClient,
  viajeId: string,
  choferId: string,
): Promise<{ ok: true; viaje: ViajeEntrega } | { ok: false; motivo: 'viaje_invalido' | 'ya_entregada' }> {
  const { rows } = await c.query<ViajeEntrega>(
    `SELECT id, tipo, estado, chofer_id, contenedor_numero, completada_en, cliente_telefono, grupo_id, destino_direccion
       FROM viajes WHERE id = $1 FOR UPDATE`,
    [viajeId],
  );
  const viaje = rows[0];
  if (!viaje || viaje.tipo !== 'entrega' || !['programado', 'en_curso'].includes(viaje.estado)) {
    return { ok: false, motivo: 'viaje_invalido' };
  }
  if (viaje.completada_en) return { ok: false, motivo: 'ya_entregada' };

  let esSuya = viaje.chofer_id === choferId;
  if (!esSuya && !viaje.chofer_id && viaje.grupo_id) {
    const { rows: r } = await c.query(
      `SELECT 1 FROM viajes WHERE grupo_id = $1 AND tipo = 'retiro' AND chofer_id = $2 LIMIT 1`,
      [viaje.grupo_id, choferId],
    );
    esSuya = r.length > 0;
  }
  if (!esSuya) return { ok: false, motivo: 'viaje_invalido' };
  return { ok: true, viaje };
}

/** Nombre del cliente para los mensajes de alerta (o su teléfono si no lo tiene cargado). */
async function nombreCliente(c: PoolClient, telefono: string | null): Promise<string | null> {
  const { rows } = await c.query<{ nombre: string | null }>('SELECT nombre FROM clientes WHERE telefono = $1', [telefono]);
  return rows[0]?.nombre && rows[0].nombre !== 'Sin nombre' ? rows[0].nombre : telefono;
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
 * Solo acepta contenedores disponibles. Si el que escribió el chofer no
 * existe o no está disponible, el bot registra la entrega igual con
 * registrarEntregaAVerificar y la oficina asigna el correcto. Excepción: una
 * entrega del flujo viejo que ya traía su contenedor reservado se completa
 * con ese mismo.
 */
export async function asignarContenedorAEntrega(params: {
  viajeId: string;
  numero: string;
  choferId: string;
  choferNombre: string;
}): Promise<ResultadoAsignacion> {
  const { viajeId, numero, choferId, choferNombre } = params;

  const resultado = await withTx(async (c) => {
    const v = await bloquearEntregaDelChofer(c, viajeId, choferId);
    if (!v.ok) return v;
    const viaje = v.viaje;

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

    const cliente = await nombreCliente(c, viaje.cliente_telefono);
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

/** "c 14", "C-014", "c014" -> "C014": para comparar sin guiones, espacios ni mayúsculas. */
function claveContenedor(texto: string): string {
  return texto.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * El contenedor que el chofer quiso decir con lo que escribió: mismo número
 * sin importar guiones, espacios o mayúsculas ("c 14" = "C-14"). Si no hay,
 * por los dígitos sin ceros adelante ("14" = "C-014"), pero solo si hay un
 * único contenedor con ese número — si no, no se adivina.
 */
export async function buscarContenedorInformado(
  texto: string,
): Promise<{ numero: string; tamano: number | null; estado: string } | null> {
  const clave = claveContenedor(texto);
  if (!clave) return null;
  const [exacto] = await query<{ numero: string; tamano: number | null; estado: string }>(
    `SELECT numero, tamano, estado::text AS estado FROM contenedores
      WHERE regexp_replace(UPPER(numero), '[^A-Z0-9]', '', 'g') = $1 LIMIT 1`,
    [clave],
  );
  if (exacto) return exacto;
  const digitos = clave.replace(/\D/g, '').replace(/^0+/, '');
  if (!digitos) return null;
  const porDigitos = await query<{ numero: string; tamano: number | null; estado: string }>(
    `SELECT numero, tamano, estado::text AS estado FROM contenedores
      WHERE ltrim(regexp_replace(numero, '[^0-9]', '', 'g'), '0') = $1 LIMIT 2`,
    [digitos],
  );
  return porDigitos.length === 1 ? porDigitos[0] : null;
}

export type ResultadoAVerificar =
  | { ok: true; viaje: { id: string; cliente_telefono: string | null; grupo_id: string | null } }
  | { ok: false; motivo: 'viaje_invalido' | 'ya_entregada' };

/**
 * El chofer confirmó un contenedor que no existe o no está disponible: la
 * entrega se registra igual (no se lo traba en la calle) pero sin
 * contenedor — queda "a verificar", con lo que escribió en
 * contenedor_informado, y una alerta para que la oficina asigne el correcto
 * (asignarContenedorVerificado). Sin contenedor no hay vencimiento ni retiro
 * automático todavía: salen al asignarlo, contados desde hoy.
 */
export async function registrarEntregaAVerificar(params: {
  viajeId: string;
  informado: string;
  motivo: string;
  choferId: string;
  choferNombre: string;
}): Promise<ResultadoAVerificar> {
  const { viajeId, informado, motivo, choferId, choferNombre } = params;
  const resultado = await withTx(async (c) => {
    const v = await bloquearEntregaDelChofer(c, viajeId, choferId);
    if (!v.ok) return v;
    const viaje = v.viaje;
    const { rows: choferRows } = await c.query<{ patente: string | null }>('SELECT patente FROM choferes WHERE id = $1', [choferId]);
    await c.query(
      `UPDATE viajes SET completada_en = now(), contenedor_informado = $2,
              chofer_id = COALESCE(chofer_id, $3), patente = COALESCE(patente, $4)
        WHERE id = $1`,
      [viaje.id, informado, choferId, choferRows[0]?.patente ?? null],
    );
    const cliente = await nombreCliente(c, viaje.cliente_telefono);
    const { rows: alertas } = await c.query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('contenedor_a_verificar', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [
        viaje.id,
        `${choferNombre} entregó${viaje.grupo_id ? ' (recambio)' : ''}${cliente ? ` a ${cliente}` : ''} y escribió "${informado}", ` +
          `pero ${motivo}. Asigná el contenedor correcto.`,
      ],
    );
    return {
      ok: true as const,
      viaje: { id: viaje.id, cliente_telefono: viaje.cliente_telefono, grupo_id: viaje.grupo_id },
      alerta: alertas[0] as unknown,
    };
  });
  if (!resultado.ok) return resultado;
  if (resultado.alerta) emitAlerta({ ...(resultado.alerta as object), cliente_telefono: resultado.viaje.cliente_telefono });
  emitRecursoActualizado('viajes');
  return { ok: true, viaje: resultado.viaje };
}

/**
 * La oficina asigna el contenedor de una entrega "a verificar" (el chofer
 * escribió uno que no existía o no estaba disponible). Solo se acepta uno
 * DISPONIBLE y sin otra entrega activa, así que la entrega siempre termina
 * con un contenedor correcto. El vencimiento se cuenta desde el día real de
 * la entrega (completada_en), no desde que se resolvió. Cierra la alerta.
 */
export async function asignarContenedorVerificado(params: {
  viajeId: string;
  numero: string;
  actualizadoPor: string;
}): Promise<{ ok: true; numero: string } | { ok: false; error: string }> {
  const { viajeId, numero, actualizadoPor } = params;
  const r = await withTx(async (c): Promise<{ ok: true; numero: string } | { ok: false; error: string }> => {
    const { rows: viajes } = await c.query<{ tipo: string; estado: string; contenedor_numero: string | null; completada_en: string | null }>(
      'SELECT tipo, estado, contenedor_numero, completada_en FROM viajes WHERE id = $1 FOR UPDATE',
      [viajeId],
    );
    const viaje = viajes[0];
    if (!viaje || viaje.tipo !== 'entrega' || viaje.estado === 'cancelado') return { ok: false, error: 'Esa entrega ya no está activa.' };
    if (!viaje.completada_en) return { ok: false, error: 'Esta entrega todavía no se hizo: el contenedor lo informa el chofer al entregar.' };
    if (viaje.contenedor_numero) return { ok: false, error: `Esta entrega ya tiene el ${viaje.contenedor_numero}. Para corregirlo usá "Cambiar".` };

    const { rows: conts } = await c.query<{ numero: string; estado: string }>(
      'SELECT numero, estado FROM contenedores WHERE UPPER(numero) = UPPER($1) FOR UPDATE',
      [numero.trim()],
    );
    const cont = conts[0];
    if (!cont) return { ok: false, error: `No existe el contenedor ${numero}. Si existe de verdad, dalo de alta primero.` };
    if (cont.estado !== 'disponible') return { ok: false, error: `El ${cont.numero} no está disponible (figura ${cont.estado}).` };
    const { rows: ocupado } = await c.query(
      `SELECT 1 FROM viajes WHERE contenedor_numero = $1 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso') LIMIT 1`,
      [cont.numero],
    );
    if (ocupado.length > 0) return { ok: false, error: `El ${cont.numero} ya está en otra entrega.` };

    // disponible -> reservado -> entregado (el trigger no permite saltar directo).
    await c.query(`UPDATE contenedores SET estado = 'reservado', actualizado_por = $2 WHERE numero = $1`, [cont.numero, actualizadoPor]);
    await c.query(
      `UPDATE contenedores SET estado = 'entregado', vence_en = fn_vencimiento_habil($2, $3), actualizado_por = $4 WHERE numero = $1`,
      [cont.numero, viaje.completada_en, DIAS_ALQUILER_ANTES_RETIRO, actualizadoPor],
    );
    await c.query('UPDATE viajes SET contenedor_numero = $2 WHERE id = $1', [viajeId, cont.numero]);
    await c.query(
      `UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'contenedor_a_verificar' AND referencia_id = $1 AND estado <> 'resuelta'`,
      [viajeId],
    );
    return { ok: true, numero: cont.numero };
  });
  if (r.ok) {
    emitAlertaActualizada({ tipo: 'contenedor_a_verificar', referencia_id: viajeId, estado: 'resuelta' });
    emitRecursoActualizado('contenedores');
    emitRecursoActualizado('viajes');
  }
  return r;
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
