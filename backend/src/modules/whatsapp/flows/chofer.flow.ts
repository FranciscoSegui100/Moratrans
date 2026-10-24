import { query } from '../../../config/db';
import { sendText, sendList, sendButtons } from '../graphApi';
import { setSesion, clearSesion, registrarIntentoInvalido } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';

import { finalizarRetiro } from '../../../services/retiro.service';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import { DIAS_ALQUILER_ANTES_RETIRO, LIMITE_INTENTOS_INVALIDOS } from '../../../config/bot.config';
import { avisarSiguienteParadaRuta, avisarSiguienteParadaDesde, avisarChoferViaje, avisarChoferRecambio } from '../../viajes/viajes.routes';
import { notificarClienteServicioFinalizado } from '../notificacionesCliente';
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

/**
 * Antes, un error real al aplicar un estado (no el caso común de doble
 * toque, ya filtrado aparte) solo quedaba en el console.error de Railway —
 * invisible para la empresa salvo que el chofer llamara a quejarse. Ahora
 * también queda una alerta en el panel con el contenedor y el motivo.
 */
async function alertarErrorChofer(choferId: string, choferNombre: string, numero: string, motivo: string): Promise<void> {
  // referencia_id distinta de la que usa "chofer trabado en el bot" (esa usa
  // choferId pelado) para que un error real de transición no quede tapado
  // por el ON CONFLICT si ya había una alerta de otro tipo abierta para el
  // mismo chofer.
  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('chofer_necesita_ayuda', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [`${choferId}:transicion:${numero}`, `Error aplicando un estado para ${choferNombre} en el contenedor ${numero}: ${motivo}`],
  );
  if (alerta) emitAlerta(alerta);
}

export async function handleChofer(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  // 1) Identificación por teléfono
const chofer = await query<{ id: string; nombre: string }>(
  'SELECT id, nombre FROM choferes WHERE telefono = $1 AND activo = TRUE',
  [to],
);
if (chofer.length === 0) {
  await sendText(to, '⚠️ No se reconoce el número de chofer.');
  return;
}

  // 2) Chofer reconocido: manejar cambio de estado, elección de contenedor,
  // y las dos acciones self-service (vaciado y autoasignación del vacío de
  // un recambio). `cont:` y `recgrupo:` llegan tanto de una lista (elegir
  // entre varios candidatos) como de un botón pegado a un aviso de
  // asignación puntual (un solo candidato, ya sabido de antemano) — mismo
  // id, dos formas de mandarlo, por eso se aceptan los dos tipos acá.
  const esSeleccion = m.tipo === 'interactive_button' || m.tipo === 'interactive_list';
  // 'estado:' ya no lo manda ningún mensaje nuevo (el menú fijo de "Ya
  // entregué/Ya retiré" se sacó, ver menuChofer), pero se mantiene el
  // handler por si un chofer todavía tiene un mensaje viejo con ese botón
  // sin tocar en su WhatsApp.
  if (m.tipo === 'interactive_button' && m.seleccionId?.startsWith('estado:')) {
    return elegirContenedor(to, chofer[0].id, m.seleccionId.replace('estado:', ''));
  }
  if (esSeleccion && m.seleccionId?.startsWith('cont:')) {
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
  if (esSeleccion && m.seleccionId?.startsWith('vaciado:')) {
    return aplicarVaciado(to, chofer[0].id, chofer[0].nombre, m.seleccionId.replace('vaciado:', ''));
  }
  if (esSeleccion && m.seleccionId?.startsWith('recgrupo:')) {
    return elegirVacioRecambio(to, chofer[0].id, m.seleccionId.replace('recgrupo:', ''));
  }
  if (esSeleccion && m.seleccionId?.startsWith('cobro_efectivo:')) {
    const [, accion, pagoId] = m.seleccionId.split(':');
    if (accion === 'si' && pagoId) {
      await query(
        `UPDATE pagos SET efectivo_cobrado = TRUE WHERE id = $1 AND medio_pago = 'efectivo'`,
        [pagoId],
      );
      emitRecursoActualizado('pagos');
      await sendText(to, `💵 ¡Excelente! Registrado como cobrado en el sistema. Muchas gracias, ${chofer[0].nombre}. 👍`);
    } else {
      await sendText(to, `⚠️ Entendido. El viaje quedó marcado como NO cobrado en el sistema para que lo revise administración.`);
    }
    await clearSesion(to);
    return menuChofer(to, chofer[0].nombre);
  }
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('recvacio:') && sesion.paso === 'elegir_vacio_recambio') {
    return aplicarVacioRecambio(to, chofer[0].id, chofer[0].nombre, m.seleccionId.replace('recvacio:', ''), sesion);
  }

  // Soporte para respuestas por texto libre o si el cliente no usa botones interactivos
  const txt = (m.texto ?? '').toLowerCase().trim();
  // "vacié"/"vaciado": la opción 🗑️ que le indica el mensaje de "Registrado"
  // al retirar un lleno (ya no se le ofrece sola pegada a ese mensaje).
  if (txt.includes('vaci')) {
    if (!(await ofrecerVaciadosPendientes(to, chofer[0].id))) {
      await sendText(to, `👍 No tenés contenedores pendientes de vaciar, ${chofer[0].nombre}.`);
    }
    return;
  }
  if (txt.includes('retir')) {
    return elegirContenedor(to, chofer[0].id, 'retirado');
  }
  if (txt.includes('entreg')) {
    return elegirContenedor(to, chofer[0].id, 'entregado');
  }
  if (txt.includes('ruta') || txt === 'hoy' || txt.includes('pendiente')) {
    return handleRutaDeHoy(to, chofer[0].id, chofer[0].nombre);
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

  // No se reconoció nada de lo de arriba. Mismo contador que usa el lado
  // cliente (sesiones_chat.intentos_invalidos — se resetea solo en la
  // próxima transición válida vía setSesion/clearSesion), pero acá no hay
  // un botón de "hablar con alguien" de por medio: un chofer manejando no
  // debería tener que tocar nada más, así que al segundo intento fallido
  // seguido se avisa directo al panel en vez de insistir con el mismo
  // mensaje para siempre.
  const intentosFallidos = await registrarIntentoInvalido(to);
  if (intentosFallidos < LIMITE_INTENTOS_INVALIDOS) {
    await sendText(
      to,
      `🚚 No entendí eso, ${chofer[0].nombre}. Escribí *ruta* para ver qué tenés pendiente, o tocá el botón del aviso correspondiente.`,
    );
    return;
  }

  // Solo se avisa (alerta al panel + mensaje al chofer) la PRIMERA vez que
  // cruza el límite — antes esto corría en cada mensaje sin reconocer que
  // llegara DESPUÉS de la escalación, y como intentos_invalidos no se resetea
  // hasta una transición válida, un chofer trabado mandando varios mensajes
  // seguidos recibía el mismo "ya avisé al equipo" una y otra vez, de verdad,
  // por WhatsApp.
  if (intentosFallidos === LIMITE_INTENTOS_INVALIDOS) {
    const [alerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('chofer_necesita_ayuda', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [chofer[0].id, `${chofer[0].nombre} no está pudiendo avanzar en el bot (varios mensajes sin reconocer).`],
    );
    if (alerta) emitAlerta(alerta);
    await sendText(
      to,
      `🚚 Ya le avisé a alguien del equipo que estás con problemas, ${chofer[0].nombre}. Te van a contactar. Mientras tanto, escribí *ruta* para ver qué tenés pendiente.`,
    );
  }
  return menuChofer(to, chofer[0].nombre);
}

/**
 * Ya no manda un menú fijo de botones ("Ya entregué"/"Ya retiré"): ese botón
 * ahora viaja pegado al propio mensaje de cada asignación puntual, con el
 * contenedor ya embebido en el id (ver avisarChoferViaje/avisarChoferRecambio
 * en viajes.routes.ts, avisarChoferAsignacion en pagos.routes.ts) — así el
 * chofer completa en un solo toque en el caso normal de un solo trabajo
 * activo, sin tener que elegir de una lista.
 *
 * Esta función quedó reducida a las dos ofertas self-service que no
 * dependen de una asignación puntual: contenedores propios esperando
 * confirmar el vaciado, y un recambio propio esperando que se le asigne el
 * vacío. El respaldo para cuando el chofer no tiene a mano el mensaje
 * puntual (o tiene más de un trabajo activo a la vez) sigue siendo escribir
 * "entregué"/"retiré" en texto libre (ver handleChofer más arriba).
 */
export async function menuChofer(to: string, nombre?: string): Promise<void> {
  const [chofer] = await query<{ id: string }>(
    'SELECT id FROM choferes WHERE telefono = $1 AND activo = TRUE',
    [to],
  );
  if (!chofer) return; // no debería pasar (ya se validó identidad antes de llegar acá)
  await ofrecerVaciadosPendientes(to, chofer.id);
  await ofrecerRecambioPendiente(to, chofer.id);
}

/**
 * El chofer escribe "ruta"/"hoy"/"pendiente" para recuperar lo que tiene
 * asignado AHORA MISMO si se le perdió el aviso, se quedó sin señal o
 * cambió de turno. A propósito NUNCA muestra la ruta completa de una: solo
 * reenvía la(s) parada(s) que ya son "el frente" — la próxima a completar
 * de cada ruta confirmada (mismo criterio que avisarSiguienteParadaRuta:
 * la de menor `orden` sin completar), o cualquier viaje asignado suelto
 * sin ruta (ya se le avisó individualmente al crearlo, no hay nada que
 * esconder ahí). Mostrar toda la ruta de una dejaría que un chofer más
 * rápido "primereara" a otros y agarrara varias paradas sin haber
 * entregado ninguna — por eso el aviso normal también es de a una.
 */
async function handleRutaDeHoy(to: string, choferId: string, choferNombre: string): Promise<void> {
  await clearSesion(to);

  const frente = await query<{
    id: string; tipo: 'entrega' | 'retiro'; contenedor_numero: string | null; destino_direccion: string | null;
    ubicacion_id: string | null; grupo_id: string | null; cliente_telefono: string | null;
    hora_estimada: string | null; pago_id: string | null;
  }>(
    `SELECT id, tipo, contenedor_numero, destino_direccion, ubicacion_id, grupo_id, cliente_telefono, hora_estimada, pago_id
       FROM viajes v
      WHERE v.chofer_id = $1 AND v.tipo IN ('entrega', 'retiro')
        AND v.estado IN ('programado', 'en_curso') AND v.completada_en IS NULL
        AND (
          v.ruta_id IS NULL
          OR (v.ruta_confirmada_en IS NOT NULL AND v.chofer_notificado_en IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM viajes v2
                 WHERE v2.ruta_id = v.ruta_id AND v2.orden < v.orden AND v2.completada_en IS NULL
              ))
        )
      ORDER BY v.orden NULLS LAST, v.creado_en`,
    [choferId],
  );

  if (frente.length === 0) {
    await sendText(to, `🚚 No tenés ninguna parada asignada en este momento, ${choferNombre}. Te aviso apenas tengas algo nuevo.`);
    return menuChofer(to, choferNombre);
  }

  await sendText(to, `🚚 Esto es lo que tenés pendiente ahora, ${choferNombre}:`);

  const yaMostrados = new Set<string>();
  for (const v of frente) {
    if (yaMostrados.has(v.id)) continue;
    yaMostrados.add(v.id);
    // Recambio: las dos filas (retiro del lleno + entrega del vacío)
    // comparten grupo_id y van juntas en un solo aviso, mismo criterio que
    // avisarSiguienteParadaRuta — no dos mensajes separados para una sola visita.
    const pareja = v.grupo_id ? frente.find((p) => p.grupo_id === v.grupo_id && p.id !== v.id) : undefined;
    if (pareja) yaMostrados.add(pareja.id);

    const entrega = v.tipo === 'entrega' ? v : pareja?.tipo === 'entrega' ? pareja : undefined;
    const retiro = v.tipo === 'retiro' ? v : pareja?.tipo === 'retiro' ? pareja : undefined;

    if (entrega?.grupo_id && retiro) {
      await avisarChoferRecambio(
        choferId, retiro.contenedor_numero!, entrega.contenedor_numero, entrega.ubicacion_id,
        entrega.destino_direccion, entrega.cliente_telefono, entrega.hora_estimada, retiro.pago_id ?? entrega.pago_id,
      );
    } else {
      await avisarChoferViaje(choferId, v.tipo, v.contenedor_numero, v.destino_direccion, v.cliente_telefono, v.hora_estimada, v.pago_id);
    }
  }
}

/** Contenedores propios ya retirados del cliente, esperando que confirme que los vació. Devuelve si había alguno. */
async function ofrecerVaciadosPendientes(to: string, choferId: string): Promise<boolean> {
  const pendientes = await query<{ contenedor_numero: string }>(
    `SELECT DISTINCT contenedor_numero FROM viajes
      WHERE chofer_id = $1 AND tipo = 'retiro' AND estado = 'en_curso' AND contenedor_numero IS NOT NULL
      ORDER BY contenedor_numero`,
    [choferId],
  );
  if (pendientes.length === 0) return false;
  await sendList(
    to,
    '🗑️ Confirmar vaciado',
    '¿Ya vaciaste alguno de estos contenedores en el vaciadero?',
    'Ver contenedores',
    pendientes.map((p) => ({ id: `vaciado:${p.contenedor_numero}`, title: p.contenedor_numero })),
  );
  return true;
}

/**
 * Recambios propios (ya tiene asignado el retiro del lleno) esperando que diga
 * con qué vacío completa la entrega. Solo los que ya le llegaron: asignados
 * directo (sin ruta) o de una ruta que ya se le despachó — un recambio de una
 * ruta todavía sin despachar (ej. la de mañana) no se le ofrece antes de
 * tiempo, le llega con el aviso de su parada.
 */
async function ofrecerRecambioPendiente(to: string, choferId: string): Promise<void> {
  const pendientes = await query<{ entrega_id: string; lleno_numero: string }>(
    `SELECT e.id AS entrega_id, r.contenedor_numero AS lleno_numero
       FROM viajes r
       JOIN viajes e ON e.grupo_id = r.grupo_id AND e.tipo = 'entrega' AND e.contenedor_numero IS NULL
        AND e.estado IN ('programado', 'en_curso')
      WHERE r.chofer_id = $1 AND r.tipo = 'retiro' AND r.grupo_id IS NOT NULL
        AND r.estado IN ('programado', 'en_curso')
        AND (r.ruta_id IS NULL OR r.chofer_notificado_en IS NOT NULL)
      ORDER BY r.creado_en`,
    [choferId],
  );
  if (pendientes.length === 0) return;

  const disponibles = await contenedoresDisponibles();
  if (disponibles.length === 0) return; // nada para ofrecer todavía — no hay ningún vacío en stock

  if (pendientes.length === 1) {
    return enviarListaVacios(to, pendientes[0].entrega_id, pendientes[0].lleno_numero, disponibles);
  }
  await sendList(
    to,
    '🔄 Recambio pendiente',
    'Tenés más de un recambio asignado — ¿para cuál tenés el vacío?',
    'Ver recambios',
    pendientes.map((p) => ({ id: `recgrupo:${p.entrega_id}`, title: `Lleno ${p.lleno_numero}` })),
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

/** El chofer eligió CUÁL de sus recambios pendientes completar (sólo aparece cuando tiene más de uno). */
async function elegirVacioRecambio(to: string, choferId: string, entregaId: string): Promise<void> {
  const [pendiente] = await query<{ contenedor_numero: string }>(
    `SELECT r.contenedor_numero
       FROM viajes e JOIN viajes r ON r.grupo_id = e.grupo_id AND r.tipo = 'retiro'
      WHERE e.id = $1 AND e.tipo = 'entrega' AND e.contenedor_numero IS NULL AND r.chofer_id = $2`,
    [entregaId, choferId],
  );
  if (!pendiente) {
    await sendText(to, '🙁 Ese recambio ya no está disponible. Escribí *menú* para volver a empezar.');
    return;
  }
  const disponibles = await contenedoresDisponibles();
  if (disponibles.length === 0) {
    await sendText(to, '🙁 No hay contenedores vacíos disponibles en este momento.');
    return;
  }
  await enviarListaVacios(to, entregaId, pendiente.contenedor_numero, disponibles);
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
    return menuChofer(to, choferNombre);
  }
  // Si este vaciado era una parada de una ruta (insertada automáticamente al
  // retirar, ver insertarVaciadoAutomatico), sigue la secuencia desde ahí —
  // la próxima parada de la ruta, o el próximo vaciado si hubiera otro
  // pendiente antes. Si no hay ruta de por medio (vaciado suelto, fuera de
  // cualquier ruta), sigue mandando el menú como siempre.
  const [paradaVaciado] = await query<{ ruta_id: string; orden: number }>(
    `SELECT rv.ruta_id, rv.orden
       FROM ruta_vaciados rv
       JOIN rutas r ON r.id = rv.ruta_id
      WHERE rv.contenedor_numero = $1 AND r.chofer_id = $2
      ORDER BY rv.creado_en DESC LIMIT 1`,
    [numero, choferId],
  );
  if (paradaVaciado) {
    const siguienteEnviada = await avisarSiguienteParadaDesde(paradaVaciado.ruta_id, paradaVaciado.orden).catch((e) => {
      console.error('Error avisando siguiente parada tras vaciado:', e.message);
      return false;
    });
    if (siguienteEnviada) return;
  }
  return menuChofer(to, choferNombre);
}

/**
 * Si `numero` es parte de un recambio (grupo_id) y su pareja (el otro
 * contenedor del mismo recambio) ya está lista para transicionar, la marca
 * en el mismo momento. Se llama SIEMPRE que un contenedor pasa a 'entregado'
 * o 'retirado' — así no importa si el vacío se asignó desde el panel o por
 * WhatsApp, ni cuál de los dos lados toca el chofer primero: el otro sigue
 * solo. Devuelve el texto para sumar al mensaje de confirmación ('' si no
 * había pareja o todavía no estaba lista).
 *
 * NO avisa la parada siguiente de la ruta: eso lo hace el llamador, una sola
 * vez y DESPUÉS de mandar su confirmación. Antes se avisaba acá adentro, así
 * que al chofer le llegaba la parada siguiente antes del "Registrado" — y
 * después el llamador la volvía a avisar (con las dos mitades del recambio ya
 * completas, las dos llamadas avanzaban).
 */
async function cascadearParejaRecambio(
  numero: string,
  choferId: string,
  choferNombre: string,
): Promise<string> {
  const [propio] = await query<{ tipo: string; grupo_id: string | null }>(
    `SELECT tipo, grupo_id FROM viajes
      WHERE contenedor_numero = $1 AND chofer_id = $2 AND grupo_id IS NOT NULL AND estado IN ('programado', 'en_curso')
      ORDER BY creado_en DESC LIMIT 1`,
    [numero, choferId],
  );
  if (!propio?.grupo_id) return '';

  const parejaTipo = propio.tipo === 'retiro' ? 'entrega' : 'retiro';
  const [pareja] = await query<{ id: string; contenedor_numero: string | null }>(
    `SELECT id, contenedor_numero FROM viajes
      WHERE grupo_id = $1 AND tipo = $2 AND estado IN ('programado', 'en_curso')
      ORDER BY creado_en DESC LIMIT 1`,
    [propio.grupo_id, parejaTipo],
  );
  if (!pareja?.contenedor_numero) return ''; // el vacío todavía no se asignó — nada para cascadear

  const [cont] = await query<{ estado: string }>('SELECT estado FROM contenedores WHERE numero = $1', [pareja.contenedor_numero]);

  if (parejaTipo === 'entrega') {
    // La pareja es el vacío: se entrega si está 'reservado' (ya asignado, esperando salir).
    if (cont?.estado !== 'reservado') return '';
    // Mismo vencimiento que cualquier entrega (días de alquiler desde AHORA):
    // antes acá no se cargaba vence_en y el vacío de un recambio quedaba sin
    // fecha — nunca le llegaba el recordatorio ni el retiro automático.
    await query(
      `UPDATE contenedores SET estado = 'entregado', vence_en = now() + make_interval(days => $3), actualizado_por = $2 WHERE numero = $1`,
      [pareja.contenedor_numero, `chofer:${choferId}`, DIAS_ALQUILER_ANTES_RETIRO],
    );
    await query(`UPDATE viajes SET completada_en = now() WHERE id = $1`, [pareja.id]);
    // El cascadeo cambia el contenedor/viaje de la pareja: se avisa acá adentro
    // para que valga sin importar el orden en que el llamador emita lo suyo.
    emitRecursoActualizado('contenedores');
    emitRecursoActualizado('viajes');
    return ` y entregaste *${pareja.contenedor_numero}*`;
  }

  // La pareja es el lleno: se retira (yendo a vaciar) si está 'entregado'.
  if (cont?.estado !== 'entregado') return '';
  const vaciadero = await resolverUbicacion('vaciadero');
  await query(
    `UPDATE viajes SET estado = 'en_curso', completada_en = now(),
            ubicacion_id = COALESCE(ubicacion_id, $2), ubicacion_direccion = COALESCE(ubicacion_direccion, $3)
      WHERE id = $1`,
    [pareja.id, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
  );
  await query(`UPDATE contenedores SET estado = 'retirado', actualizado_por = $2 WHERE numero = $1`, [pareja.contenedor_numero, `chofer:${choferId}`]);
  emitRecursoActualizado('contenedores');
  emitRecursoActualizado('viajes');
  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('confirmar_retiro', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [pareja.contenedor_numero, `${choferNombre} completó el recambio: retiró ${pareja.contenedor_numero}, va camino al vaciadero.`],
  );
  if (alerta) emitAlerta(alerta);
  return ` y retiraste *${pareja.contenedor_numero}* (yendo a vaciar)`;
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
    await query(
      `UPDATE viajes SET contenedor_numero = $1, chofer_id = $2, patente = $3
        WHERE id = $4 AND contenedor_numero IS NULL`,
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
    const [entregaViaje] = await query<{ cliente_telefono: string | null }>(
      `UPDATE viajes SET completada_en = now() WHERE id = $1 RETURNING cliente_telefono`,
      [entregaId],
    );
    if (entregaViaje?.cliente_telefono) {
      notificarClienteServicioFinalizado({
        clienteTelefono: entregaViaje.cliente_telefono,
        tipo: 'entrega',
        contenedorNumero: numero,
      }).catch((e) => console.error('Error enviando encuesta al cliente (recambio):', e));
    }

    const mensajeLleno = await cascadearParejaRecambio(numero, choferId, choferNombre);

    emitRecursoActualizado('contenedores');
    emitRecursoActualizado('viajes');
    await sendText(
      to,
      `✅ Recambio registrado. Contenedor *${numero}* entregado${mensajeLleno}. ${mensajeLleno ? 'Avisame por acá cuando vacíes el lleno (opción 🗑️ del menú). ' : ''}Gracias por tu trabajo. 🙌`,
    );

    // Verificar si el recambio tiene pago en efectivo pendiente
    const [pagoEfectivo] = await query<{ pago_id: string; monto: string | null }>(
      `SELECT p.id AS pago_id, COALESCE(p.monto, pe.precio)::text AS monto
         FROM viajes v
         JOIN pagos p ON p.id = v.pago_id
         LEFT JOIN pedidos pe ON pe.id = p.pedido_id
        WHERE v.id = $1
          AND p.medio_pago = 'efectivo'
          AND p.efectivo_cobrado = FALSE`,
      [entregaId],
    );

    if (pagoEfectivo) {
      const montoTxt = pagoEfectivo.monto ? ` por *$${Number(pagoEfectivo.monto).toLocaleString('es-AR')}*` : '';
      await sendButtons(
        to,
        `💵 *Cobro en efectivo*\n\n¿Cobraste el pago en efectivo${montoTxt} al cliente?`,
        [
          { id: `cobro_efectivo:si:${pagoEfectivo.pago_id}`, title: '✅ Sí, ya cobré' },
          { id: `cobro_efectivo:no:${pagoEfectivo.pago_id}`, title: '❌ No cobré' },
        ],
      );
    }

    // Después de la confirmación: avisar la parada siguiente de la ruta (una
    // sola vez, con las dos mitades del recambio ya completas). Si se retiró
    // el lleno no se manda el menú suelto: traería la lista de "¿ya vaciaste?"
    // pegada al recambio recién hecho — el vaciado lo avisa el chofer después.
    const siguienteEntrega = await avisarSiguienteParadaRuta(entregaId).catch((e) => {
      console.error('Error avisando siguiente parada:', e.message);
      return false;
    });
    if (!siguienteEntrega && !mensajeLleno) return menuChofer(to, choferNombre);
    return;
  } catch (err: any) {
    await sendText(to, `⚠️ No pudimos completar el recambio con el contenedor ${numero}. Probá de nuevo.`);
    console.error('Error en aplicarVacioRecambio:', err.message);
    await alertarErrorChofer(choferId, choferNombre, numero, err.message).catch((e) => console.error('Error registrando alerta:', e));
  }
  return menuChofer(to, choferNombre);
}

/** Tras elegir estado, listar contenedores candidatos. */
async function elegirContenedor(to: string, choferId: string, estado: string): Promise<void> {
  if (!ESTADOS_CHOFER.includes(estado as any)) {
    await sendText(to, 'Esa acción no está disponible para choferes.');
    return menuChofer(to);
  }
  // Contenedores en un estado desde el que la transición es válida.
  const origen = estado === 'entregado' ? 'reservado' : 'entregado';
  // El viaje activo tiene que ser del tipo que realmente pide esa acción —
  // sin esto, un contenedor recién entregado (cuyo viaje de 'entrega' sigue
  // "activo" hasta que se cierra todo el ciclo, ver retiro.service.ts)
  // aparecía como candidato para "Ya retiré" aunque nadie hubiera pedido el
  // retiro todavía.
  const tipoRequerido = estado === 'entregado' ? 'entrega' : 'retiro';
  // Solo contenedores con un viaje activo asignado a ESTE chofer.
  // Se usa DISTINCT ON (c.numero) para garantizar IDs únicos y no saturar Meta API.
  // Se trae también el cliente y la dirección del viaje: sin esto, el chofer
  // solo veía el número de contenedor en la lista y no tenía forma de
  // confirmar que estaba por marcar la parada correcta cuando maneja varias
  // entregas/retiros el mismo día.
  const conts = await query<{
    numero: string; grupo_id: string | null; tipo: string; pareja_numero: string | null; pareja_tipo: string | null;
    destino_direccion: string | null; cliente_nombre: string | null;
  }>(
    `SELECT DISTINCT ON (c.numero)
            c.numero, v.grupo_id, v.tipo, pareja.contenedor_numero AS pareja_numero, pareja.tipo AS pareja_tipo,
            v.destino_direccion, cl.nombre AS cliente_nombre
       FROM contenedores c
       JOIN viajes v ON v.contenedor_numero = c.numero
       LEFT JOIN clientes cl ON cl.telefono = v.cliente_telefono
       LEFT JOIN LATERAL (
         SELECT v2.contenedor_numero, v2.tipo
           FROM viajes v2
          WHERE v2.grupo_id = v.grupo_id AND v2.id <> v.id
          LIMIT 1
       ) pareja ON TRUE
      WHERE c.estado = $1
        AND v.chofer_id = $2
        AND v.tipo = $3
        AND v.estado IN ('programado', 'en_curso')
      ORDER BY c.numero, c.actualizado_en DESC
      LIMIT 11`,
    [origen, choferId, tipoRequerido],
  );
  if (conts.length === 0) {
    await sendText(to, `🙁 No tenés contenedores en estado "${origen}" para pasar a "${estado.replace('_', ' ')}".`);
    return menuChofer(to);
  }
  // Una lista de WhatsApp admite 10 filas como máximo — si hay más, se le
  // avisa que puede escribir el número directo (ver sesion.paso ===
  // 'elegir_contenedor' en handleChofer) en vez de dejarlo sin saber que
  // le faltan opciones.
  const hayMas = conts.length > 10;
  const candidatos = conts.slice(0, 10);
  await setSesion({ telefono: to, flujo: 'chofer', paso: 'elegir_contenedor', contexto: { estado } });
  await sendList(
    to,
    LABEL_ESTADO[estado as keyof typeof LABEL_ESTADO],
    '¿Cuál contenedor? Fijate el cliente y la dirección para confirmar que es la parada correcta.' +
      (hayMas ? '\n\n_Tenés más de 10 — si no está en la lista, escribime directamente el número._' : ''),
    'Ver contenedores',
    candidatos.map((c) => {
      const clienteODireccion = [c.cliente_nombre, c.destino_direccion].filter(Boolean).join(' — ') || 'Sin datos del cliente';
      const recambio = c.grupo_id
        ? c.pareja_tipo === 'retiro'
          ? `🔄 Recambio, retira lleno ${c.pareja_numero} · `
          : `🔄 Recambio, entrega vacío ${c.pareja_numero} · `
        : '';
      return {
        id: `cont:${estado}:${c.numero}`,
        title: c.numero,
        description: `${recambio}${clienteODireccion}`,
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
      // Los 3 reads de acá abajo son independientes entre sí (ninguno usa el
      // resultado de otro) — en paralelo, aunque en los dos casos de salida
      // temprana de más abajo (sin retiro pedido / doble toque) terminen sin
      // usarse: sigue siendo 1 round-trip en vez de 3 en el camino feliz.
      const [[entrega], vaciadero, [retiroExistente]] = await Promise.all([
        // Dirección/zona del cliente: se copian de la entrega de este contenedor
        query<{ destino_direccion: string | null; zona: string | null }>(
          `SELECT destino_direccion, zona FROM viajes
            WHERE contenedor_numero = $1 AND tipo = 'entrega'
            ORDER BY creado_en DESC LIMIT 1`,
          [numero],
        ),
        resolverUbicacion('vaciadero'),
        // Tiene que existir un viaje de retiro real (pedido por el cliente,
        // o generado por un recambio) — no se acepta "ya retiré" ad-hoc sin
        // que nadie lo haya solicitado, mismo criterio que para el resto de
        // los estados (ver elegirContenedor, que ya filtra por esto para no
        // ofrecerlo como opción en primer lugar; esto es la segunda barrera
        // por si igual llega un id de contenedor que no corresponde).
        query<{ id: string; completada_en: string | null }>(
          `SELECT id, completada_en FROM viajes
            WHERE contenedor_numero = $1 AND tipo = 'retiro' AND estado IN ('programado', 'en_curso')
            ORDER BY creado_en DESC LIMIT 1`,
          [numero],
        ),
      ]);
      if (!retiroExistente) {
        await sendText(to, `🙁 El contenedor ${numero} todavía no tiene un retiro solicitado, no se puede marcar como retirado.`);
        await clearSesion(to);
        return menuChofer(to, choferNombre);
      }
      // Doble toque sobre el mismo aviso viejo (típico con señal mala — el
      // chofer no ve que ya se registró y vuelve a tocar): ya estaba hecho,
      // no es un error. Sin este chequeo, el resto de la función se repetía
      // entera — reenviaba la encuesta al cliente y la parada siguiente de
      // la ruta DE NUEVO, como si fueran dos entregas distintas.
      if (retiroExistente.completada_en) {
        await clearSesion(to);
        await sendText(to, `👍 Tranqui, el retiro de *${numero}* ya estaba registrado. Todo bien.`);
        return menuChofer(to, choferNombre);
      }
      const retiroId = retiroExistente.id;
      const [retiroActualizado] = await query<{ cliente_telefono: string | null }>(
        `UPDATE viajes SET estado = 'en_curso', completada_en = now(),
                chofer_id = COALESCE(chofer_id, $2),
                destino_direccion = COALESCE(destino_direccion, $3),
                zona = COALESCE(zona, $4),
                ubicacion_id = COALESCE(ubicacion_id, $5),
                ubicacion_direccion = COALESCE(ubicacion_direccion, $6)
          WHERE id = $1
          RETURNING cliente_telefono`,
        [retiroExistente.id, choferId, entrega?.destino_direccion ?? null, entrega?.zona ?? null, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
      );
      if (retiroActualizado?.cliente_telefono) {
        notificarClienteServicioFinalizado({
          clienteTelefono: retiroActualizado.cliente_telefono,
          tipo: 'retiro',
          contenedorNumero: numero,
        }).catch((e) => console.error('Error enviando encuesta de retiro al cliente:', e));
      }
      // Tablas distintas, ninguna lee el resultado de la otra — en paralelo.
      const [, [alerta]] = await Promise.all([
        query(
          `UPDATE contenedores SET estado = 'retirado', actualizado_por = $2 WHERE numero = $1`,
          [numero, `chofer:${choferId}`],
        ),
        // Visibilidad para el panel (ya no bloquea nada — se resuelve sola
        // cuando el chofer marca "vaciado", ver retiro.service.ts).
        query(
          `INSERT INTO alertas (tipo, referencia_id, mensaje)
           VALUES ('confirmar_retiro', $1, $2)
           ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
           RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
          [numero, `${choferNombre} retiró el contenedor ${numero} del cliente, va camino al vaciadero.`],
        ),
      ]);
      if (alerta) emitAlerta(alerta);
      // Si este lleno es parte de un recambio y el vacío pareja ya está
      // asignado y en 'reservado', se entrega en el mismo momento — así no
      // importa si el chofer marca primero el lleno o el vacío.
      const extraVacio = await cascadearParejaRecambio(numero, choferId, choferNombre);
      emitRecursoActualizado('contenedores');
      emitRecursoActualizado('viajes');
      await clearSesion(to);
      await sendText(
        to,
        `📥 Registrado. Contenedor *${numero}* marcado como retirado${extraVacio}. Avisame por acá cuando lo vacíes en el vaciadero (opción 🗑️ del menú). Gracias por tu trabajo. 🙌`,
      );
      // Después de la confirmación: avisar la parada siguiente de la ruta (una
      // sola vez — si era un recambio, las dos mitades ya están completas). Sin
      // el menú suelto: traería la lista de "¿ya vaciaste?" pegada al retiro
      // recién hecho; el vaciado lo avisa el chofer cuando lo hace.
      await avisarSiguienteParadaRuta(retiroId).catch((e) => {
        console.error('Error avisando siguiente parada:', e.message);
        return false;
      });
      return;
    } catch (err: any) {
      await sendText(to, `⚠️ No pudimos registrar el retiro del contenedor ${numero}. Probá de nuevo.`);
      console.error('Error registrando retiro pendiente:', err.message);
      await alertarErrorChofer(choferId, choferNombre, numero, err.message).catch((e) => console.error('Error registrando alerta:', e));
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
    const [entregaAsignada] = await query<{ id: string; completada_en: string | null }>(
      `SELECT id, completada_en FROM viajes
        WHERE contenedor_numero = $1 AND chofer_id = $2 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso')
        LIMIT 1`,
      [numero, choferId],
    );
    if (!entregaAsignada) {
      await sendText(to, `🙁 No tenés ninguna entrega asignada para el contenedor ${numero}.`);
      await clearSesion(to);
      return menuChofer(to, choferNombre);
    }
    // Mismo chequeo de doble toque que el branch 'retirado' de arriba: ya
    // estaba completada, no es un error — y evita reenviar la encuesta al
    // cliente y la parada siguiente de la ruta por segunda vez.
    if (entregaAsignada.completada_en) {
      await clearSesion(to);
      await sendText(to, `👍 Tranqui, la entrega de *${numero}* ya estaba registrada. Todo bien.`);
      return menuChofer(to, choferNombre);
    }
    // El trigger fn_validar_transicion_contenedor rechaza transiciones ilegales.
    // A esta altura `estado` siempre es 'entregado' (el único otro valor
    // posible, 'retirado', ya retornó más arriba). El vencimiento son los
    // días de alquiler estándar contados desde AHORA, el momento real de la
    // entrega — no la fecha programada del viaje: si se entregó antes o
    // después de lo previsto, el vencimiento tiene que correrse con él.
    // Escrituras a tablas distintas, ninguna lee el resultado de la otra —
    // en paralelo. La marca de la parada de entrega (alimenta la vista día:
    // "marcó hace X min" por chofer) solo aplica acá — 'retirado' ya se
    // marca más arriba, donde crea/actualiza su propia fila de viajes.
    const [, entregasCompletadas] = await Promise.all([
      query(
        `UPDATE contenedores SET estado = $1, vence_en = now() + make_interval(days => $2), actualizado_por = $3
          WHERE numero = $4`,
        [estado, DIAS_ALQUILER_ANTES_RETIRO, `chofer:${choferId}`, numero],
      ),
      estado === 'entregado'
        ? query<{ id: string; cliente_telefono: string | null }>(
            `UPDATE viajes SET completada_en = now()
              WHERE contenedor_numero = $1 AND chofer_id = $2 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso')
              RETURNING id, cliente_telefono`,
            [numero, choferId],
          )
        : [],
    ]);
    // El trigger fn_auditar_contenedor ya audita este cambio en historial_contenedores
    // (con chofer_id resuelto desde actualizado_por) — no duplicar el insert acá.
    // Este cambio viene del webhook de WhatsApp, no de la API del panel, así
    // que no pasa por el middleware que avisa solo (broadcastCambios) — sin
    // esto, la pestaña Contenedores quedaba desactualizada hasta hacer F5.
    emitRecursoActualizado('contenedores');
    // La pestaña Viajes ahora muestra el estado del contenedor asociado
    // (join en GET /api/viajes), así que también tiene que refrescarse sola.
    emitRecursoActualizado('viajes');
    for (const ec of entregasCompletadas) {
      if (ec.cliente_telefono) {
        notificarClienteServicioFinalizado({
          clienteTelefono: ec.cliente_telefono,
          tipo: 'entrega',
          contenedorNumero: numero,
        }).catch((e) => console.error('Error enviando encuesta de entrega al cliente:', e));
      }
    }
    // Si esto es el vacío de un recambio y el lleno pareja ya está listo
    // (entregado), se retira en el mismo momento (yendo a vaciar) — así no
    // importa si el chofer marca primero el vacío o el lleno. Corre en
    // paralelo con el chequeo de pago en efectivo de abajo: ninguno de los
    // dos lee el resultado del otro, y "pagoEfectivo" no hace falta hasta
    // después de mandar el mensaje de confirmación.
    const [extra, [pagoEfectivo]] = await Promise.all([
      cascadearParejaRecambio(numero, choferId, choferNombre),
      // Verificar si el viaje tiene pago en efectivo pendiente de cobrar
      query<{ pago_id: string; monto: string | null }>(
        `SELECT p.id AS pago_id, COALESCE(p.monto, pe.precio)::text AS monto
           FROM viajes v
           JOIN pagos p ON p.id = v.pago_id
           LEFT JOIN pedidos pe ON pe.id = p.pedido_id
          WHERE v.id = $1
            AND p.medio_pago = 'efectivo'
            AND p.efectivo_cobrado = FALSE`,
        [entregaAsignada.id],
      ),
    ]);
    // Si de yapa se retiró el lleno de un recambio, sin menú suelto (mismo
    // criterio que el branch 'retirado': nada de "¿ya vaciaste?" pegado).
    if (extra) siguienteEnviada = true;
    await clearSesion(to);
    await sendText(to, `✅ Registrado. Contenedor *${numero}* marcado como *${estado.replace('_', ' ')}*${extra}. 💪`);

    if (pagoEfectivo) {
      const montoTxt = pagoEfectivo.monto ? ` por *$${Number(pagoEfectivo.monto).toLocaleString('es-AR')}*` : '';
      await sendButtons(
        to,
        `💵 *Cobro en efectivo*\n\n¿Cobraste el pago en efectivo${montoTxt} al cliente?`,
        [
          { id: `cobro_efectivo:si:${pagoEfectivo.pago_id}`, title: '✅ Sí, ya cobré' },
          { id: `cobro_efectivo:no:${pagoEfectivo.pago_id}`, title: '❌ No cobré' },
        ],
      );
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
    // Error de transición inválida u otro. Se suma el estado actual real del
    // contenedor al mensaje — "puede que no esté en el estado correcto" sin
    // decir cuál es no le sirve al chofer para saber qué pasó.
    const [contActual] = await query<{ estado: string }>('SELECT estado FROM contenedores WHERE numero = $1', [numero]).catch(() => [] as { estado: string }[]);
    await sendText(
      to,
      `⚠️ No pudimos aplicar el cambio en el contenedor ${numero}.` +
        (contActual ? ` Ahora mismo figura como "${contActual.estado.replace('_', ' ')}".` : '') +
        ' Avisé al equipo para que lo revise.',
    );
    console.error('Error aplicarEstado:', err.message);
    await alertarErrorChofer(choferId, choferNombre, numero, err.message).catch((e) => console.error('Error registrando alerta:', e));
  }
  // El aviso de la parada siguiente ya trajo su propio menú: no duplicarlo.
  if (!siguienteEnviada) return menuChofer(to, choferNombre);
}
