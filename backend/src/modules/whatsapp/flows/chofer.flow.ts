import { query } from '../../../config/db';
import { sendText, sendList, sendButtons } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { blindIndex } from '../../../services/crypto.service';
import { finalizarRetiro } from '../../../services/retiro.service';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import { DIAS_ALQUILER_ANTES_RETIRO } from '../../../config/bot.config';
import { avisarSiguienteParadaRuta } from '../../viajes/viajes.routes';
import { nombreClienteParaAlerta } from '../../../services/clientes.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

// Únicos estados que un chofer puede aplicar. Ya no existe "voy en camino":
// una entrega pasa directo de 'reservado' a 'entregado' (ver migración
// 0019_eliminar_en_camino.sql y el trigger fn_validar_transicion_contenedor).
const ESTADOS_CHOFER = ['entregado', 'retirado'] as const;

// Título del botón: WhatsApp corta a 20 caracteres, por eso van cortos.
const LABEL_ESTADO: Record<(typeof ESTADOS_CHOFER)[number], string> = {
  entregado: '📦 Ya entregué',
  retirado: '📥 Ya retiré',
};

export async function handleChofer(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  // 1) Identificación por teléfono
  const chofer = await query<{ id: string; nombre: string }>(
    'SELECT id, nombre FROM choferes WHERE telefono = $1 AND activo = TRUE',
    [to],
  );

  // 1a) No reconocido: pedir DNI para validar
  if (chofer.length === 0) {
    if (sesion.paso === 'esperando_dni' && m.tipo === 'text') {
      const dni = (m.texto ?? '').replace(/\D/g, '');
      // DNI argentino: 7 u 8 dígitos. Filtra tipeos/mensajes sueltos antes de
      // consultar o generar una alerta — evita ruido al operador por errores
      // de tipeo (antes cualquier texto generaba una alerta nueva).
      if (dni.length < 7 || dni.length > 8) {
        await sendText(to, '⚠️ Ese número no parece un DNI válido. Por favor, enviá tu *DNI* completo, solo los números.');
        return;
      }
      const match = await query<{ id: string; nombre: string; telefono: string | null }>(
        'SELECT id, nombre, telefono FROM choferes WHERE dni_hash = $1 AND activo = TRUE',
        [blindIndex(dni)],
      );
      if (match.length > 0) {
        const chofer = match[0];
        if (!chofer.telefono) {
          // Primer vínculo: no hay número previo que pisar, se aplica directo.
          await query('UPDATE choferes SET telefono = $1 WHERE id = $2', [to, chofer.id]);
          await clearSesion(to);
          await sendText(to, `✅ Identidad confirmada, ${chofer.nombre}. Tu número quedó vinculado. 🚚`);
          return menuChofer(to);
        }
        // Ya tiene otro número vinculado: el DNI solo no alcanza para pisarlo
        // (evita que alguien con el DNI de un chofer le robe el número). Requiere
        // que un operador lo revise y lo cambie a mano desde el panel.
        const [alerta] = await query(
          `INSERT INTO alertas (tipo, referencia_id, mensaje)
           VALUES ('chofer_cambio_telefono', $1, $2)
           ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
           RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
          [
            chofer.id,
            `${chofer.nombre} ya tiene el número ${chofer.telefono} vinculado, pero alguien se validó con su DNI desde ${to}. Si es realmente ${chofer.nombre}, cambiá el teléfono desde la ficha del chofer.`,
          ],
        );
        if (alerta) emitAlerta(alerta);
        await clearSesion(to);
        await sendText(
          to,
          '🔒 Ese DNI ya tiene otro número de WhatsApp vinculado. Avisamos a un operador para que confirme el cambio antes de aplicarlo.',
        );
        return;
      }
      // No coincide: hasta 2 reintentos sin molestar a nadie (permite corregir
      // un tipeo); a partir del tercero, se deriva a un operador — y solo se
      // crea UNA alerta por número (antes cada intento fallido generaba una
      // fila nueva en alertas, aunque fuera la misma persona reintentando).
      const intentos = ((sesion.contexto?.intentosDni as number) || 0) + 1;
      if (intentos < 3) {
        await setSesion({ telefono: to, flujo: 'chofer', paso: 'esperando_dni', contexto: { intentosDni: intentos } });
        await sendText(to, '⚠️ No encontramos ese DNI. Revisá el número y enviámelo de nuevo.');
        return;
      }
      const [alerta] = await query(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('chofer_no_reconocido', $1, $2)
         ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
         RETURNING id, tipo, referencia_id, mensaje, creado_en`,
        [to, `Chofer no reconocido (${to}) intentó validarse con DNI ${dni}`],
      );
      if (alerta) emitAlerta(alerta);
      await clearSesion(to);
      await sendText(
        to,
        '🙁 No pudimos validar ese DNI. Ya avisamos a un operador para que se comunique con vos.',
      );
      return;
    }
    // Primer contacto: pedir DNI
    await setSesion({ telefono: to, flujo: 'chofer', paso: 'esperando_dni', contexto: {} });
    await sendText(to, '🚚 Hola. No tengo este número registrado como chofer. Para identificarte, enviame tu *DNI* (solo los números).');
    return;
  }

  // Respuesta a "¿Cobraste $X en efectivo?" (ver aplicarEstado) — el id del
  // botón lleva el pago_id en vez de depender de sesion.paso, así no importa
  // qué otro mensaje/menú se haya mandado después (siguiente parada, etc.).
  // Va ANTES que todo lo demás — incluido el chequeo de 'estado:' de abajo —
  // porque es la única acción permitida mientras queda una pregunta pendiente.
  if (m.tipo === 'interactive_button' && m.seleccionId?.startsWith('efectivo:')) {
    return manejarConfirmacionEfectivo(to, m.seleccionId, chofer[0].nombre, sesion);
  }
  // Mientras quede una pregunta de cobro sin responder, no se deja pasar a
  // ninguna otra acción (retirar, entregar, recambio) — así no se pierde el
  // dato de si cobró o no yéndose a la siguiente parada sin contestar. Tiene
  // que ir ANTES del chequeo de 'estado:' de abajo: un botón viejo de "Ya
  // entregué"/"Ya retiré" de un mensaje anterior sigue siendo tocable en
  // WhatsApp aunque ya no correspondiera usarlo.
  if (sesion.paso === 'esperando_confirmacion_efectivo') {
    await sendText(to, '⚠️ Antes de seguir, respondé arriba si cobraste el efectivo pendiente. 👆');
    return;
  }

  // 2) Chofer reconocido: manejar cambio de estado (botones), elección de
  // contenedor (lista), y las dos acciones self-service nuevas (vaciado y
  // autoasignación del vacío de un recambio).
  if (m.tipo === 'interactive_button' && m.seleccionId?.startsWith('estado:')) {
    return elegirContenedor(to, chofer[0].id, chofer[0].nombre, m.seleccionId.replace('estado:', ''), sesion);
  }
  // 'cont:' puede venir como botón directo (un solo candidato, ver
  // menuChofer) o como lista (varios candidatos, ver elegirContenedor).
  if ((m.tipo === 'interactive_button' || m.tipo === 'interactive_list') && m.seleccionId?.startsWith('cont:')) {
    const raw = m.seleccionId.replace('cont:', '');
    const parts = raw.split(':');
    let targetEstado: string;
    let numero: string;
    if (parts.length === 2) {
      targetEstado = parts[0];
      numero = parts[1];
    } else {
      numero = parts[0];
      targetEstado = (sesion.contexto?.estado as string) || '';
    }
    return aplicarEstado(to, chofer[0].id, chofer[0].nombre, numero, sesion, targetEstado);
  }
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('vaciado:')) {
    return aplicarVaciado(to, chofer[0].id, chofer[0].nombre, m.seleccionId.replace('vaciado:', ''));
  }
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('recvacio:') && sesion.paso === 'elegir_vacio_recambio') {
    return aplicarVacioRecambio(to, chofer[0].id, chofer[0].nombre, m.seleccionId.replace('recvacio:', ''), sesion);
  }
  // "🔄 Hice el recambio" (ver menuChofer) — un solo toque para las dos
  // patas, en vez de tener que adivinar entre "Ya entregué" / "Ya retiré".
  if (m.tipo === 'interactive_button' && m.seleccionId === 'recambio_hecho') {
    const recambios = await recambiosActivos(chofer[0].id);
    if (recambios.length === 0) {
      await sendText(to, '🙁 No tenés ningún recambio activo en este momento.');
      return menuChofer(to, chofer[0].nombre);
    }
    if (recambios.length === 1) {
      const r = recambios[0];
      return marcarRecambioHecho(to, chofer[0].id, chofer[0].nombre, r.entregaId, r.llenoNumero, r.vacioAsignado, sesion);
    }
    await sendList(
      to,
      '🔄 ¿Cuál recambio?',
      'Tenés más de un recambio activo — ¿cuál ya realizaste?',
      'Ver recambios',
      recambios.map((r) => ({ id: `recambiohecho:${r.llenoNumero}`, title: `Lleno ${r.llenoNumero}` })),
    );
    return;
  }
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('recambiohecho:')) {
    const llenoNumero = m.seleccionId.replace('recambiohecho:', '');
    const recambios = await recambiosActivos(chofer[0].id);
    const r = recambios.find((x) => x.llenoNumero === llenoNumero);
    if (!r) {
      await sendText(to, '🙁 Ese recambio ya no está disponible. Escribí *menú* para volver a empezar.');
      return;
    }
    return marcarRecambioHecho(to, chofer[0].id, chofer[0].nombre, r.entregaId, r.llenoNumero, r.vacioAsignado, sesion);
  }

  // Soporte para respuestas por texto libre o si el cliente no usa botones interactivos
  const txt = (m.texto ?? '').toLowerCase().trim();
  if (txt.includes('retir')) {
    return elegirContenedor(to, chofer[0].id, chofer[0].nombre, 'retirado', sesion);
  }
  if (txt.includes('entreg')) {
    return elegirContenedor(to, chofer[0].id, chofer[0].nombre, 'entregado', sesion);
  }
  if (sesion.paso === 'elegir_contenedor' && m.tipo === 'text' && m.texto) {
    const inputNumero = m.texto.trim();
    const estado = sesion.contexto?.estado as string;
    if (estado) {
      const origen = estado === 'entregado' ? 'reservado' : 'entregado';
      const match = await query<{ numero: string }>(
        `SELECT DISTINCT c.numero
           FROM contenedores c
           JOIN viajes v ON v.contenedor_numero = c.numero
          WHERE c.estado = $1 AND v.chofer_id = $2 AND v.estado IN ('programado', 'en_curso')
            AND LOWER(c.numero) = LOWER($3)`,
        [origen, chofer[0].id, inputNumero],
      );
      if (match.length > 0) {
        return aplicarEstado(to, chofer[0].id, chofer[0].nombre, match[0].numero, sesion, estado);
      }
    }
  }

  return menuChofer(to, chofer[0].nombre);
}

/**
 * Menú principal del chofer: hasta 3 botones pegados al mensaje (un solo
 * toque), en vez de una lista desplegable — más rápido para alguien
 * manejando. Se manda después de cada acción para que nunca tenga que
 * escribir "menú".
 *
 * A diferencia de la versión anterior, los botones NO son genéricos: solo
 * aparece "Ya entregué" si de verdad tiene una entrega pendiente, solo
 * "Ya retiré" si tiene un retiro pendiente, y solo "Hice el recambio" si
 * tiene un recambio activo — así nunca tiene que elegir entre dos acciones
 * para una sola visita (ej. un recambio ya no ofrece también "Ya retiré").
 * Cuando la categoría tiene un único candidato, el botón actúa directo sobre
 * ese contenedor (id `cont:<estado>:<numero>`) sin preguntar cuál es — la
 * lista para elegir (ver elegirContenedor) solo aparece si hay ambigüedad
 * real (2 o más candidatos).
 *
 * Si además el chofer tiene contenedores propios en "retirado" esperando
 * confirmar el vaciado, se manda una lista aparte con esa acción —
 * WhatsApp permite un máximo de 3 botones por mensaje, por eso no se puede
 * agregar ahí mismo.
 */
export async function menuChofer(to: string, nombre?: string): Promise<void> {
  const [chofer] = await query<{ id: string }>(
    'SELECT id FROM choferes WHERE telefono = $1 AND activo = TRUE',
    [to],
  );
  if (!chofer) return; // no debería pasar (ya se validó identidad antes de llegar acá)

  const [entregas, retiros, recambios] = await Promise.all([
    candidatosEstado(chofer.id, 'entregado'),
    candidatosEstado(chofer.id, 'retirado'),
    recambiosActivos(chofer.id),
  ]);

  const botones: { id: string; title: string }[] = [];
  if (entregas.length === 1) botones.push({ id: `cont:entregado:${entregas[0].numero}`, title: LABEL_ESTADO.entregado });
  else if (entregas.length > 1) botones.push({ id: 'estado:entregado', title: LABEL_ESTADO.entregado });
  if (retiros.length === 1) botones.push({ id: `cont:retirado:${retiros[0].numero}`, title: LABEL_ESTADO.retirado });
  else if (retiros.length > 1) botones.push({ id: 'estado:retirado', title: LABEL_ESTADO.retirado });
  if (recambios.length > 0) botones.push({ id: 'recambio_hecho', title: '🔄 Hice el recambio' });

  const saludo = nombre ? `🚚 Hola, ${nombre}.` : '🚚 Panel del chofer.';
  if (botones.length === 0) {
    await sendText(to, `${saludo} No tenés ninguna entrega, retiro o recambio pendiente en este momento.`);
  } else {
    await sendButtons(to, `${saludo} ¿Qué acción querés registrar?`, botones);
  }
  await ofrecerVaciadosPendientes(to, chofer.id);
}

/**
 * Condición SQL: esta parada es "la actual" — o es un viaje suelto (sin
 * ruta armada), o es la de menor `orden` entre las de su ruta que todavía
 * no se completaron. Sin esto, un chofer con varias paradas en la misma
 * ruta veía TODAS como candidatas para "Ya entregué"/"Ya retiré"/el
 * recambio, aunque todavía no le hubiéramos avisado de las siguientes (ver
 * avisarSiguienteParadaRuta, que sigue el mismo criterio para decidir cuál
 * avisar a continuación). `alias` es el alias de tabla usado en cada query
 * (siempre texto fijo interno, nunca input externo).
 */
function condicionParadaActual(alias: string): string {
  return `(${alias}.ruta_id IS NULL OR (
    ${alias}.ruta_confirmada_en IS NOT NULL
    AND ${alias}.orden = (
      SELECT MIN(x.orden) FROM viajes x
       WHERE x.ruta_id = ${alias}.ruta_id AND x.completada_en IS NULL AND x.estado IN ('programado', 'en_curso')
    )
  ))`;
}

/**
 * Candidatos reales para pasar a `estado` (entregado/retirado): solo la
 * parada actual de cada ruta (ver condicionParadaActual) y excluyendo los
 * contenedores que son parte de un recambio (grupo_id) — esos se resuelven
 * con "Hice el recambio" (ver recambiosActivos/marcarRecambioHecho), no acá,
 * para no ofrecer dos botones distintos para la misma visita.
 */
async function candidatosEstado(
  choferId: string,
  estado: string,
): Promise<{ numero: string; destino_direccion: string | null; cliente_nombre: string | null; medio_pago: string | null; medio_pago_alargue: string | null }[]> {
  const origen = estado === 'entregado' ? 'reservado' : 'entregado';
  const tipoRequerido = estado === 'entregado' ? 'entrega' : 'retiro';
  return query(
    `SELECT DISTINCT ON (c.numero)
            c.numero, v.destino_direccion, cl.nombre AS cliente_nombre, pg.medio_pago, alargue.medio_pago AS medio_pago_alargue
       FROM contenedores c
       JOIN viajes v ON v.contenedor_numero = c.numero
       LEFT JOIN clientes cl ON cl.telefono = v.cliente_telefono
       LEFT JOIN pagos pg ON pg.id = v.pago_id
       -- Extensión pedida en algún momento de este ciclo (por contenedor, sin
       -- relación con viajes.pago_id) — solo importa para "Ya retiré": el
       -- cobro de una extensión se hace en ese momento, no al entregar.
       LEFT JOIN LATERAL (
         SELECT medio_pago FROM pagos
          WHERE contenedor_numero = c.numero AND tipo = 'alargue_retiro' AND estado <> 'rechazado' AND efectivo_cobrado = FALSE
          ORDER BY creado_en DESC LIMIT 1
       ) alargue ON TRUE
      WHERE c.estado = $1
        AND v.chofer_id = $2
        AND v.tipo = $3
        AND v.estado IN ('programado', 'en_curso')
        AND v.grupo_id IS NULL
        AND ${condicionParadaActual('v')}
      ORDER BY c.numero, c.actualizado_en DESC
      LIMIT 10`,
    [origen, choferId, tipoRequerido],
  );
}

/**
 * Recambios activos de este chofer (retiro del lleno asignado, la visita
 * todavía sin completar) — para ofrecer "🔄 Hice el recambio" en el menú
 * principal en vez de dejar que adivine entre "Ya entregué" / "Ya retiré",
 * que no describen bien lo que en la práctica es una sola visita. Incluye
 * tanto los que ya tienen el vacío asignado (alcanza con marcar el lleno,
 * cascadearParejaRecambio completa el otro lado) como los que todavía no
 * (primero hay que preguntar con cuál lo completó, ver marcarRecambioHecho).
 * Igual que candidatosEstado, solo trae la parada actual de cada ruta.
 */
async function recambiosActivos(choferId: string): Promise<{ llenoNumero: string; entregaId: string; vacioAsignado: boolean }[]> {
  const rows = await query<{ lleno_numero: string; entrega_id: string; vacio_numero: string | null }>(
    `SELECT r.contenedor_numero AS lleno_numero, e.id AS entrega_id, e.contenedor_numero AS vacio_numero
       FROM viajes r
       JOIN viajes e ON e.grupo_id = r.grupo_id AND e.tipo = 'entrega' AND e.estado IN ('programado', 'en_curso')
      WHERE r.chofer_id = $1 AND r.tipo = 'retiro' AND r.grupo_id IS NOT NULL AND r.estado IN ('programado', 'en_curso')
        AND ${condicionParadaActual('r')}
      ORDER BY r.creado_en`,
    [choferId],
  );
  return rows.map((r) => ({ llenoNumero: r.lleno_numero, entregaId: r.entrega_id, vacioAsignado: !!r.vacio_numero }));
}

/**
 * El chofer marcó "🔄 Hice el recambio" (un solo toque para las dos patas).
 * Si el vacío todavía no está asignado en el sistema, primero hace falta
 * preguntar con cuál lo completó (ver enviarListaVacios/aplicarVacioRecambio,
 * que ya registran las dos patas juntas). Si ya estaba asignado, alcanza con
 * marcar el lleno como retirado: cascadearParejaRecambio (dentro de
 * aplicarEstado) completa el vacío en el mismo momento.
 */
async function marcarRecambioHecho(
  to: string,
  choferId: string,
  choferNombre: string,
  entregaId: string,
  llenoNumero: string,
  vacioAsignado: boolean,
  sesion: Sesion,
): Promise<void> {
  if (!vacioAsignado) {
    const disponibles = await contenedoresDisponibles();
    if (disponibles.length === 0) {
      await sendText(to, '🙁 No hay contenedores vacíos disponibles en este momento.');
      return menuChofer(to, choferNombre);
    }
    return enviarListaVacios(to, entregaId, llenoNumero, disponibles);
  }
  return aplicarEstado(to, choferId, choferNombre, llenoNumero, sesion, 'retirado');
}

/** Contenedores propios ya retirados del cliente, esperando que confirme que los vació. */
async function ofrecerVaciadosPendientes(to: string, choferId: string): Promise<void> {
  const pendientes = await query<{ contenedor_numero: string }>(
    `SELECT DISTINCT contenedor_numero FROM viajes
      WHERE chofer_id = $1 AND tipo = 'retiro' AND estado = 'en_curso' AND contenedor_numero IS NOT NULL
      ORDER BY contenedor_numero`,
    [choferId],
  );
  if (pendientes.length === 0) return;
  await sendList(
    to,
    '🗑️ Confirmar vaciado',
    '¿Ya vaciaste alguno de estos contenedores en el vaciadero?',
    'Ver contenedores',
    pendientes.map((p) => ({ id: `vaciado:${p.contenedor_numero}`, title: p.contenedor_numero })),
  );
}

async function contenedoresDisponibles(): Promise<{ numero: string }[]> {
  return query<{ numero: string }>(`SELECT numero FROM contenedores WHERE estado = 'disponible' ORDER BY creado_en LIMIT 10`);
}

async function enviarListaVacios(
  to: string,
  entregaId: string,
  llenoNumero: string,
  disponibles: { numero: string }[],
): Promise<void> {
  await setSesion({ telefono: to, flujo: 'chofer', paso: 'elegir_vacio_recambio', contexto: { entregaId } });
  await sendList(
    to,
    '🔄 Completar recambio',
    `¿Con qué contenedor vacío completás el recambio del lleno *${llenoNumero}*? Al elegirlo se registra todo junto: el vacío queda entregado y el lleno queda retirado, camino al vaciadero.`,
    'Ver contenedores',
    disponibles.map((d) => ({ id: `recvacio:${d.numero}`, title: d.numero })),
  );
}

/**
 * El chofer confirma que vació uno de sus contenedores retirados: reemplaza
 * la confirmación manual que antes hacía un operador desde el panel (ver
 * retiro.service.ts, que ya se encarga de avisarle a él mismo el resultado
 * — por eso acá no se manda una segunda confirmación además del error).
 */
async function aplicarVaciado(to: string, choferId: string, choferNombre: string, numero: string): Promise<void> {
  const resultado = await finalizarRetiro(numero, `chofer:${choferId}`, choferId);
  if ('error' in resultado) {
    await sendText(to, `⚠️ No pudimos registrar el vaciado del contenedor ${numero}: ${resultado.error}`);
  }
  return menuChofer(to, choferNombre);
}

/**
 * Si `numero` es parte de un recambio (grupo_id) y su pareja (el otro
 * contenedor del mismo recambio) ya está lista para transicionar, la marca
 * en el mismo momento. Se llama SIEMPRE que un contenedor pasa a 'entregado'
 * o 'retirado' — así no importa si el vacío se asignó desde el panel o por
 * WhatsApp, ni cuál de los dos lados toca el chofer primero: el otro sigue
 * solo. Devuelve `texto` para sumar al mensaje de confirmación ('' si no
 * había pareja o todavía no estaba lista) y `siguienteEnviada` = true si al
 * cascadear se avisó una parada siguiente de la ruta (para que el llamador no
 * mande además el menú suelto).
 */
async function cascadearParejaRecambio(
  numero: string,
  choferId: string,
  choferNombre: string,
): Promise<{ texto: string; siguienteEnviada: boolean }> {
  const [propio] = await query<{ tipo: string; grupo_id: string | null }>(
    `SELECT tipo, grupo_id FROM viajes
      WHERE contenedor_numero = $1 AND chofer_id = $2 AND grupo_id IS NOT NULL AND estado IN ('programado', 'en_curso')
      ORDER BY creado_en DESC LIMIT 1`,
    [numero, choferId],
  );
  if (!propio?.grupo_id) return { texto: '', siguienteEnviada: false };

  const parejaTipo = propio.tipo === 'retiro' ? 'entrega' : 'retiro';
  const [pareja] = await query<{ id: string; contenedor_numero: string | null }>(
    `SELECT id, contenedor_numero FROM viajes
      WHERE grupo_id = $1 AND tipo = $2 AND estado IN ('programado', 'en_curso')
      ORDER BY creado_en DESC LIMIT 1`,
    [propio.grupo_id, parejaTipo],
  );
  if (!pareja?.contenedor_numero) return { texto: '', siguienteEnviada: false }; // el vacío todavía no se asignó — nada para cascadear

  const [cont] = await query<{ estado: string }>('SELECT estado FROM contenedores WHERE numero = $1', [pareja.contenedor_numero]);

  if (parejaTipo === 'entrega') {
    // La pareja es el vacío: se entrega si está 'reservado' (ya asignado, esperando salir).
    if (cont?.estado !== 'reservado') return { texto: '', siguienteEnviada: false };
    await query(`UPDATE contenedores SET estado = 'entregado', actualizado_por = $2 WHERE numero = $1`, [pareja.contenedor_numero, `chofer:${choferId}`]);
    await query(`UPDATE viajes SET completada_en = now() WHERE id = $1`, [pareja.id]);
    const siguienteEnviada = await avisarSiguienteParadaRuta(pareja.id).catch((e) => {
      console.error('Error avisando siguiente parada:', e.message);
      return false;
    });
    return { texto: ` y entregaste *${pareja.contenedor_numero}*`, siguienteEnviada };
  }

  // La pareja es el lleno: se retira (yendo a vaciar) si está 'entregado'.
  if (cont?.estado !== 'entregado') return { texto: '', siguienteEnviada: false };
  const vaciadero = await resolverUbicacion('vaciadero');
  await query(
    `UPDATE viajes SET estado = 'en_curso', completada_en = now(),
            ubicacion_id = COALESCE(ubicacion_id, $2), ubicacion_direccion = COALESCE(ubicacion_direccion, $3)
      WHERE id = $1`,
    [pareja.id, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
  );
  await query(`UPDATE contenedores SET estado = 'retirado', actualizado_por = $2 WHERE numero = $1`, [pareja.contenedor_numero, `chofer:${choferId}`]);
  const siguienteEnviada = await avisarSiguienteParadaRuta(pareja.id).catch((e) => {
    console.error('Error avisando siguiente parada:', e.message);
    return false;
  });
  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('confirmar_retiro', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [pareja.contenedor_numero, `${choferNombre} completó el recambio: retiró ${pareja.contenedor_numero}, va camino al vaciadero.`],
  );
  if (alerta) emitAlerta(alerta);
  return { texto: ` y retiraste *${pareja.contenedor_numero}* (yendo a vaciar)`, siguienteEnviada };
}

/**
 * El chofer eligió CON QUÉ contenedor vacío completa su recambio: lo asigna,
 * lo marca entregado, y de yapa cascadearParejaRecambio se encarga de pasar
 * el lleno pareja a retirado si ya está listo — antes eran 3 acciones
 * sueltas del chofer (elegir vacío, marcar "ya entregué", marcar "ya retiré"
 * del lleno), lo que generaba confusión y errores porque en la práctica es
 * UNA sola visita.
 */
async function aplicarVacioRecambio(
  to: string,
  choferId: string,
  choferNombre: string,
  numero: string,
  sesion: Sesion,
): Promise<void> {
  const entregaId = sesion.contexto.entregaId as string;
  await clearSesion(to);

  try {
    // Guard WHERE estado='disponible': si otro operador/chofer se lo llevó
    // justo antes, no lo pisamos — el chofer elige otro.
    const [vacio] = await query<{ numero: string }>(
      `UPDATE contenedores SET estado = 'reservado', actualizado_por = $2
        WHERE numero = $1 AND estado = 'disponible' RETURNING numero`,
      [numero, `chofer:${choferId}`],
    );
    if (!vacio) {
      await sendText(to, `🙁 El contenedor ${numero} ya no está disponible: alguien lo tomó justo antes. Elegí otro.`);
      return menuChofer(to, choferNombre);
    }

    const [choferRow] = await query<{ patente: string | null }>('SELECT patente FROM choferes WHERE id = $1', [choferId]);
    const [entregaActualizada] = await query<{ pago_id: string | null }>(
      `UPDATE viajes SET contenedor_numero = $1, chofer_id = $2, patente = $3
        WHERE id = $4 AND contenedor_numero IS NULL
        RETURNING pago_id`,
      [numero, choferId, choferRow?.patente ?? null, entregaId],
    );

    // 'reservado' -> 'entregado' directo (mismo trigger que usa cualquier
    // entrega): el chofer ya se lo está dejando al cliente en este momento.
    // El vencimiento son los días de alquiler estándar contados desde AHORA
    // (el momento real de entrega, no la fecha programada del viaje —
    // si se entregó antes o después de lo previsto, el vencimiento tiene
    // que correrse con él) — now() ya es un instante real en la base, así
    // que no hace falta armar ninguna fecha a mano ni pelear con zonas
    // horarias.
    await query(
      `UPDATE contenedores SET estado = 'entregado', vence_en = now() + make_interval(days => $2), actualizado_por = $3
        WHERE numero = $1`,
      [numero, DIAS_ALQUILER_ANTES_RETIRO, `chofer:${choferId}`],
    );
    await query(`UPDATE viajes SET completada_en = now() WHERE id = $1`, [entregaId]);

    const { texto: mensajeLleno, siguienteEnviada: siguienteLleno } = await cascadearParejaRecambio(numero, choferId, choferNombre);

    emitRecursoActualizado('contenedores');
    emitRecursoActualizado('viajes');
    await sendText(
      to,
      `✅ Recambio registrado. Contenedor *${numero}* entregado${mensajeLleno}. ${mensajeLleno ? 'Avisame por acá cuando vacíes el lleno (opción 🗑️ del menú). ' : ''}Gracias por tu trabajo. 🙌`,
    );

    // Mismo chequeo que en aplicarEstado: avisa si ya está pagado por
    // transferencia, o pregunta el cobro en efectivo (y bloquea el menú
    // hasta que conteste) — acá también, porque este camino no pasa por
    // aplicarEstado.
    let pendienteEfectivo: string | null = null;
    if (entregaActualizada?.pago_id) {
      const [pago] = await query<{ id: string; medio_pago: string; estado: string; efectivo_cobrado: boolean; monto: string | null }>(
        `SELECT p.id, p.medio_pago, p.estado, p.efectivo_cobrado, COALESCE(pe.precio, p.monto) AS monto
           FROM pagos p
           LEFT JOIN pedidos pe ON pe.id = p.pedido_id
          WHERE p.id = $1`,
        [entregaActualizada.pago_id],
      );
      if (await avisarEstadoPagoAlChofer(to, pago, `el contenedor ${numero}`)) pendienteEfectivo = pago!.id;
    }
    if (pendienteEfectivo) {
      await setSesion({
        telefono: to,
        flujo: 'chofer',
        paso: 'esperando_confirmacion_efectivo',
        contexto: { pagosPendientes: [pendienteEfectivo], viajeIdsSiguienteParada: [entregaId], choferNombre },
      });
      return;
    }

    // Después de la confirmación: avisar la parada siguiente de la ruta (trae su
    // propio menú, así que no se manda el menú suelto para no duplicarlo).
    const siguienteEntrega = await avisarSiguienteParadaRuta(entregaId).catch((e) => {
      console.error('Error avisando siguiente parada:', e.message);
      return false;
    });
    if (!siguienteEntrega && !siguienteLleno) return menuChofer(to, choferNombre);
    return;
  } catch (err: any) {
    await sendText(to, `⚠️ No pudimos completar el recambio con el contenedor ${numero}. Probá de nuevo.`);
    console.error('Error en aplicarVacioRecambio:', err.message);
  }
  return menuChofer(to, choferNombre);
}

/**
 * Tras elegir estado, resuelve el contenedor. Si hay un solo candidato real
 * (el caso normal: una parada a la vez, ver condicionParadaActual), actúa
 * directo sin preguntar nada más — listar para elegir solo tiene sentido si
 * hay ambigüedad de verdad (2 o más candidatos).
 */
async function elegirContenedor(to: string, choferId: string, choferNombre: string, estado: string, sesion: Sesion): Promise<void> {
  if (!ESTADOS_CHOFER.includes(estado as any)) {
    await sendText(to, 'Esa acción no está disponible para choferes.');
    return menuChofer(to, choferNombre);
  }
  const origen = estado === 'entregado' ? 'reservado' : 'entregado';
  const conts = await candidatosEstado(choferId, estado);
  if (conts.length === 0) {
    await sendText(to, `🙁 No tenés contenedores en estado "${origen}" para pasar a "${estado.replace('_', ' ')}".`);
    return menuChofer(to, choferNombre);
  }
  if (conts.length === 1) {
    return aplicarEstado(to, choferId, choferNombre, conts[0].numero, sesion, estado);
  }
  await setSesion({ telefono: to, flujo: 'chofer', paso: 'elegir_contenedor', contexto: { estado } });
  // Si alguno se cobra en efectivo (la entrega/recambio en sí, o una
  // extensión pendiente), se aclara ANTES de que el chofer marque la
  // acción — no alcanza con haberlo avisado una sola vez al asignar la
  // entrega (puede ser horas antes y quedar olvidado a esta altura).
  const hayEfectivo = conts.some((c) => c.medio_pago === 'efectivo' || c.medio_pago_alargue === 'efectivo');
  await sendList(
    to,
    LABEL_ESTADO[estado as keyof typeof LABEL_ESTADO],
    '¿Cuál contenedor? Fijate el cliente y la dirección para confirmar que es la parada correcta.' +
      (hayEfectivo ? '\n\n💵 Las marcadas *EFECTIVO* se cobran en esta visita.' : ''),
    'Ver contenedores',
    conts.map((c) => {
      const clienteODireccion = [c.cliente_nombre, c.destino_direccion].filter(Boolean).join(' — ') || 'Sin datos del cliente';
      const efectivo = c.medio_pago === 'efectivo' || c.medio_pago_alargue === 'efectivo' ? '💵 EFECTIVO · ' : '';
      return {
        id: `cont:${estado}:${c.numero}`,
        title: c.numero,
        description: `${efectivo}${clienteODireccion}`,
      };
    }),
  );
}

/** Aplica el cambio de estado (el trigger de la DB valida la transición y audita). */
async function aplicarEstado(
  to: string,
  choferId: string,
  choferNombre: string,
  numero: string,
  sesion: Sesion,
  overrideEstado?: string,
): Promise<void> {
  const estado = overrideEstado || (sesion.contexto?.estado as string);
  if (!estado || !ESTADOS_CHOFER.includes(estado as any)) {
    await sendText(to, 'Esa acción no está disponible.');
    await clearSesion(to);
    return menuChofer(to, choferNombre);
  }

  // El chofer retiró el lleno del cliente: pasa el contenedor a "retirado" ya
  // mismo (transición entregado -> retirado, permitida por el trigger) y
  // deja un viaje 'retiro' en curso.
  if (estado === 'retirado') {
    try {
      // Dirección/zona del cliente: se copian de la entrega de este contenedor
      const [entrega] = await query<{ destino_direccion: string | null; zona: string | null }>(
        `SELECT destino_direccion, zona FROM viajes
          WHERE contenedor_numero = $1 AND tipo = 'entrega'
          ORDER BY creado_en DESC LIMIT 1`,
        [numero],
      );
      const vaciadero = await resolverUbicacion('vaciadero');

      // Tiene que existir un viaje de retiro real (pedido por el cliente,
      // o generado por un recambio) — no se acepta "ya retiré" ad-hoc sin
      // que nadie lo haya solicitado, mismo criterio que para el resto de
      // los estados (ver elegirContenedor, que ya filtra por esto para no
      // ofrecerlo como opción en primer lugar; esto es la segunda barrera
      // por si igual llega un id de contenedor que no corresponde).
      const [retiroExistente] = await query<{ id: string }>(
        `SELECT id FROM viajes
          WHERE contenedor_numero = $1 AND tipo = 'retiro' AND estado IN ('programado', 'en_curso')
          ORDER BY creado_en DESC LIMIT 1`,
        [numero],
      );
      if (!retiroExistente) {
        await sendText(to, `🙁 El contenedor ${numero} todavía no tiene un retiro solicitado, no se puede marcar como retirado.`);
        await clearSesion(to);
        return menuChofer(to, choferNombre);
      }
      const retiroId = retiroExistente.id;
      const [retiroActualizado] = await query<{ pago_id: string | null }>(
        `UPDATE viajes SET estado = 'en_curso', completada_en = now(),
                chofer_id = COALESCE(chofer_id, $2),
                destino_direccion = COALESCE(destino_direccion, $3),
                zona = COALESCE(zona, $4),
                ubicacion_id = COALESCE(ubicacion_id, $5),
                ubicacion_direccion = COALESCE(ubicacion_direccion, $6)
          WHERE id = $1
          RETURNING pago_id`,
        [retiroExistente.id, choferId, entrega?.destino_direccion ?? null, entrega?.zona ?? null, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
      );
      await query(
        `UPDATE contenedores SET estado = 'retirado', actualizado_por = $2 WHERE numero = $1`,
        [numero, `chofer:${choferId}`],
      );
      // Visibilidad para el panel (ya no bloquea nada — se resuelve sola
      // cuando el chofer marca "vaciado", ver retiro.service.ts).
      const [alerta] = await query(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('confirmar_retiro', $1, $2)
         ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
         RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
        [numero, `${choferNombre} retiró el contenedor ${numero} del cliente, va camino al vaciadero.`],
      );
      if (alerta) emitAlerta(alerta);
      // Si este lleno es parte de un recambio y el vacío pareja ya está
      // asignado y en 'reservado', se entrega en el mismo momento — así no
      // importa si el chofer marca primero el lleno o el vacío.
      const { texto: extraVacio, siguienteEnviada: siguienteCascada } = await cascadearParejaRecambio(numero, choferId, choferNombre);
      emitRecursoActualizado('contenedores');
      emitRecursoActualizado('viajes');
      await clearSesion(to);
      await sendText(
        to,
        `📥 Registrado. Contenedor *${numero}* marcado como retirado${extraVacio}. Avisame por acá cuando lo vacíes en el vaciadero (opción 🗑️ del menú). Gracias por tu trabajo. 🙌`,
      );

      // Este retiro puede tener dos pagos distintos asociados, no uno solo:
      // el del recambio (compartido con la entrega del vacío, ver
      // viajes.pago_id) y el de una extensión pedida en algún momento de
      // este mismo ciclo (pagos.contenedor_numero, sin relación con viajes).
      // Un contenedor puede tener las dos cosas a la vez.
      const pendientesEfectivo: string[] = [];
      if (retiroActualizado?.pago_id) {
        const [pagoRecambio] = await query<{ id: string; medio_pago: string; estado: string; efectivo_cobrado: boolean; monto: string | null }>(
          `SELECT p.id, p.medio_pago, p.estado, p.efectivo_cobrado, COALESCE(pe.precio, p.monto) AS monto
             FROM pagos p
             LEFT JOIN pedidos pe ON pe.id = p.pedido_id
            WHERE p.id = $1`,
          [retiroActualizado.pago_id],
        );
        if (await avisarEstadoPagoAlChofer(to, pagoRecambio, `el contenedor ${numero}`)) pendientesEfectivo.push(pagoRecambio!.id);
      }
      const [pagoAlargue] = await query<{ id: string; medio_pago: string; estado: string; efectivo_cobrado: boolean; monto: string | null }>(
        `SELECT id, medio_pago, estado, efectivo_cobrado, monto
           FROM pagos
          WHERE contenedor_numero = $1 AND tipo = 'alargue_retiro' AND estado <> 'rechazado'
            AND creado_en >= COALESCE(
              (SELECT creado_en FROM viajes WHERE contenedor_numero = $1 AND tipo = 'entrega' AND estado <> 'cancelado' ORDER BY creado_en DESC LIMIT 1),
              '1970-01-01')
          ORDER BY creado_en DESC LIMIT 1`,
        [numero],
      );
      if (await avisarEstadoPagoAlChofer(to, pagoAlargue, `la extensión del contenedor ${numero}`)) pendientesEfectivo.push(pagoAlargue!.id);

      // Si quedó algo por confirmar (¿cobró o no?), el chofer no sigue con
      // otra acción hasta que conteste — ni el aviso de la parada siguiente
      // ni el menú se mandan todavía (ver 'esperando_confirmacion_efectivo').
      if (pendientesEfectivo.length > 0) {
        await setSesion({
          telefono: to,
          flujo: 'chofer',
          paso: 'esperando_confirmacion_efectivo',
          contexto: { pagosPendientes: pendientesEfectivo, viajeIdsSiguienteParada: [retiroId], choferNombre },
        });
        return;
      }

      // Después de la confirmación: avisar la parada siguiente de la ruta (trae
      // su propio menú, así que no se manda el menú suelto para no duplicarlo).
      const siguienteRetiro = await avisarSiguienteParadaRuta(retiroId).catch((e) => {
        console.error('Error avisando siguiente parada:', e.message);
        return false;
      });
      if (!siguienteRetiro && !siguienteCascada) return menuChofer(to, choferNombre);
      return;
    } catch (err: any) {
      await sendText(to, `⚠️ No pudimos registrar el retiro del contenedor ${numero}. Probá de nuevo.`);
      console.error('Error registrando retiro pendiente:', err.message);
    }
    return menuChofer(to, choferNombre);
  }

  // Se pone en true si al cerrar esta parada ya se avisó la siguiente de la
  // ruta (ese aviso trae su propio menú) — entonces no se manda el menú suelto
  // para que no le aparezca dos veces al chofer.
  let siguienteEnviada = false;

  try {
    // El trigger fn_validar_transicion_contenedor solo valida el estado PREVIO
    // del contenedor, no que este chofer tenga de verdad una entrega asignada
    // — sin este chequeo, cualquier "entregado" con id de contenedor ajeno
    // pasaría igual (mismo tipo de problema que 'retirado', ver arriba).
    const [entregaAsignada] = await query<{ id: string }>(
      `SELECT id FROM viajes
        WHERE contenedor_numero = $1 AND chofer_id = $2 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso')
        LIMIT 1`,
      [numero, choferId],
    );
    if (!entregaAsignada) {
      await sendText(to, `🙁 No tenés ninguna entrega asignada para el contenedor ${numero}.`);
      await clearSesion(to);
      return menuChofer(to, choferNombre);
    }
    // El trigger fn_validar_transicion_contenedor rechaza transiciones ilegales.
    // A esta altura `estado` siempre es 'entregado' (el único otro valor
    // posible, 'retirado', ya retornó más arriba). El vencimiento son los
    // días de alquiler estándar contados desde AHORA, el momento real de la
    // entrega — no la fecha programada del viaje: si se entregó antes o
    // después de lo previsto, el vencimiento tiene que correrse con él.
    await query(
      `UPDATE contenedores SET estado = $1, vence_en = now() + make_interval(days => $2), actualizado_por = $3
        WHERE numero = $4`,
      [estado, DIAS_ALQUILER_ANTES_RETIRO, `chofer:${choferId}`, numero],
    );
    // El trigger fn_auditar_contenedor ya audita este cambio en historial_contenedores
    // (con chofer_id resuelto desde actualizado_por) — no duplicar el insert acá.
    // Este cambio viene del webhook de WhatsApp, no de la API del panel, así
    // que no pasa por el middleware que avisa solo (broadcastCambios) — sin
    // esto, la pestaña Contenedores quedaba desactualizada hasta hacer F5.
    emitRecursoActualizado('contenedores');
    // La pestaña Viajes ahora muestra el estado del contenedor asociado
    // (join en GET /api/viajes), así que también tiene que refrescarse sola.
    emitRecursoActualizado('viajes');
    // Marca la parada de entrega como hecha (alimenta la vista día: "marcó
    // hace X min" por chofer). Solo aplica acá — 'retirado' ya se marca más
    // arriba, donde crea/actualiza su propia fila de viajes.
    const entregasCompletadas = estado === 'entregado'
      ? await query<{ id: string; pago_id: string | null }>(
          `UPDATE viajes SET completada_en = now()
            WHERE contenedor_numero = $1 AND chofer_id = $2 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso')
            RETURNING id, pago_id`,
          [numero, choferId],
        )
      : [];
    // Si esto es el vacío de un recambio y el lleno pareja ya está listo
    // (entregado), se retira en el mismo momento (yendo a vaciar) — así no
    // importa si el chofer marca primero el vacío o el lleno.
    const { texto: extra, siguienteEnviada: siguienteCascada } = await cascadearParejaRecambio(numero, choferId, choferNombre);
    if (siguienteCascada) siguienteEnviada = true;
    await clearSesion(to);
    await sendText(to, `✅ Registrado. Contenedor *${numero}* marcado como *${estado.replace('_', ' ')}*${extra}. 💪`);

    // Avisa si ya está pagado (transferencia confirmada) o pregunta el cobro
    // en efectivo — ahí mismo, es el único momento en que el chofer tiene el
    // dato fresco, en vez de depender de que oficina se acuerde de
    // preguntarle después y lo cargue a mano desde el panel.
    const pagoIds = entregasCompletadas.map((e) => e.pago_id).filter((id): id is string => !!id);
    let pendienteEfectivo: string | null = null;
    if (pagoIds.length > 0) {
      const [pago] = await query<{ id: string; medio_pago: string; estado: string; efectivo_cobrado: boolean; monto: string | null }>(
        `SELECT p.id, p.medio_pago, p.estado, p.efectivo_cobrado, COALESCE(pe.precio, p.monto) AS monto
           FROM pagos p
           LEFT JOIN pedidos pe ON pe.id = p.pedido_id
          WHERE p.id = ANY($1::uuid[])`,
        [pagoIds],
      );
      if (await avisarEstadoPagoAlChofer(to, pago, `el contenedor ${numero}`)) pendienteEfectivo = pago!.id;
    }

    // Igual que en 'retirado': si queda un cobro por confirmar, no se manda
    // ni el aviso de la próxima parada ni el menú hasta que conteste.
    if (pendienteEfectivo) {
      await setSesion({
        telefono: to,
        flujo: 'chofer',
        paso: 'esperando_confirmacion_efectivo',
        contexto: { pagosPendientes: [pendienteEfectivo], viajeIdsSiguienteParada: entregasCompletadas.map((e) => e.id), choferNombre },
      });
      return;
    }

    // Después de la confirmación: si hay una parada siguiente en la ruta se la
    // avisa (ese aviso trae su propio menú, así que abajo no se manda el suelto).
    for (const v of entregasCompletadas) {
      const enviada = await avisarSiguienteParadaRuta(v.id).catch((e) => {
        console.error('Error avisando siguiente parada:', e.message);
        return false;
      });
      if (enviada) siguienteEnviada = true;
    }
  } catch (err: any) {
    // Error de transición inválida u otro
    await sendText(
      to,
      `⚠️ No pudimos aplicar el cambio en el contenedor ${numero}. Puede que no esté en el estado correcto para esta acción.`,
    );
    console.error('Error aplicarEstado:', err.message);
  }
  // El aviso de la parada siguiente ya trajo su propio menú: no duplicarlo.
  if (!siguienteEnviada) return menuChofer(to, choferNombre);
}

/**
 * Al completar una parada de logística (entrega, retiro, o el ciclo de una
 * extensión) avisa el estado del pago asociado, si hay uno:
 *  - Ya pagado por transferencia (validado) -> informa que ya está pagado,
 *    no hace falta hacer nada.
 *  - Efectivo todavía sin cobrar -> pregunta "¿Cobraste $X?" (Sí/No), mismo
 *    mecanismo para cualquier tipo de pago (flete, recambio, alargue) — el
 *    id de los botones lleva el pago_id, ver manejarConfirmacionEfectivo.
 *  - Cualquier otro caso (pendiente de validar, ya cobrado, sin pago) -> no
 *    dice nada, no hay ninguna acción que el chofer tenga que tomar.
 * Devuelve `true` si mandó la pregunta (queda pendiente de respuesta) — el
 * llamador usa esto para no dejarlo seguir con otra acción hasta que conteste
 * (ver 'esperando_confirmacion_efectivo' en aplicarEstado/handleChofer).
 */
async function avisarEstadoPagoAlChofer(
  to: string,
  pago: { id: string; medio_pago: string; estado: string; efectivo_cobrado: boolean; monto: string | null } | undefined,
  descripcion: string,
): Promise<boolean> {
  if (!pago) return false;
  if (pago.estado === 'validado' && pago.medio_pago === 'transferencia') {
    await sendText(to, `✅ Ya está pagado por transferencia — no hace falta cobrar nada por ${descripcion}.`);
    return false;
  }
  if (pago.medio_pago === 'efectivo' && !pago.efectivo_cobrado) {
    const monto = pago.monto != null ? `ARS ${Number(pago.monto).toLocaleString('es-AR')}` : 'el importe correspondiente';
    await sendButtons(to, `💵 ¿Cobraste ${monto} en efectivo por ${descripcion}?`, [
      { id: `efectivo:si:${pago.id}`, title: '✅ Sí, cobré' },
      { id: `efectivo:no:${pago.id}`, title: '❌ No cobré' },
    ]);
    return true;
  }
  return false;
}

/**
 * Respuesta a "¿Cobraste $X en efectivo?" (ver aplicarEstado). Si dice que
 * sí, marca el pago como cobrado directo — sin esto, alguien de oficina
 * tenía que acordarse de preguntarle al chofer y cargarlo a mano desde el
 * panel. Si dice que no, se avisa al panel para que un operador haga el
 * seguimiento (se usa un tipo de alerta propio, 'efectivo_no_cobrado', en
 * vez de reusar 'pago_pendiente_validacion': ese tipo dispara los botones
 * de Validar/Rechazar en Alertas.tsx, que no aplican acá porque el pago YA
 * está validado — solo falta cobrarlo).
 *
 * Un mismo retiro puede dejar dos preguntas pendientes (recambio + alargue,
 * ver aplicarEstado) — la sesión guarda la lista completa en
 * `pagosPendientes`; recién cuando no queda ninguna se libera el gate:
 * se manda el aviso de la parada siguiente (si había alguna esperando) y el
 * menú. Hasta entonces, handleChofer no deja pasar ninguna otra acción.
 */
async function manejarConfirmacionEfectivo(to: string, seleccionId: string, choferNombre: string, sesion: Sesion): Promise<void> {
  const [, respuesta, pagoId] = seleccionId.split(':');

  if (respuesta === 'si') {
    const [pago] = await query<{ id: string }>(
      `UPDATE pagos SET efectivo_cobrado = TRUE WHERE id = $1 AND medio_pago = 'efectivo' RETURNING id`,
      [pagoId],
    );
    if (pago) {
      emitRecursoActualizado('pagos');
      await sendText(to, '✅ Confirmado. Quedó registrado en el sistema.');
    } else {
      await sendText(to, '🙁 No encontramos ese pago — avisale a un operador para que lo revise.');
    }
  } else {
    const [pagoCliente] = await query<{ cliente_telefono: string }>('SELECT cliente_telefono FROM pagos WHERE id = $1', [pagoId]);
    const identificacionCliente = pagoCliente ? await nombreClienteParaAlerta(pagoCliente.cliente_telefono) : 'un cliente';
    const [alerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('efectivo_no_cobrado', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [pagoId, `${choferNombre} avisó que TODAVÍA NO cobró el efectivo de ${identificacionCliente} — hacer seguimiento`],
    );
    if (alerta) emitAlerta(alerta);
    await sendText(to, '📋 Anotado — le avisamos a oficina para que hagan el seguimiento.');
  }

  const pendientes = ((sesion.contexto?.pagosPendientes as string[] | undefined) ?? []).filter((id) => id !== pagoId);
  if (pendientes.length > 0) {
    await setSesion({ ...sesion, contexto: { ...sesion.contexto, pagosPendientes: pendientes } });
    return; // todavía falta que conteste la otra pregunta pendiente
  }

  // Ya no queda ninguna por confirmar: recién ahora se avisa la parada
  // siguiente (si había alguna esperando) y se libera el menú.
  const viajeIds = (sesion.contexto?.viajeIdsSiguienteParada as string[] | undefined) ?? [];
  await clearSesion(to);
  let siguienteEnviada = false;
  for (const id of viajeIds) {
    const enviada = await avisarSiguienteParadaRuta(id).catch((e) => {
      console.error('Error avisando siguiente parada:', e.message);
      return false;
    });
    if (enviada) siguienteEnviada = true;
  }
  if (!siguienteEnviada) return menuChofer(to, choferNombre);
}
