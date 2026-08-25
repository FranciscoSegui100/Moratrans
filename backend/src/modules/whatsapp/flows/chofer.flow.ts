import { query } from '../../../config/db';
import { sendText, sendList, sendButtons } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { blindIndex } from '../../../services/crypto.service';
import { finalizarRetiro } from '../../../services/retiro.service';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import { sumarDias } from '../../../services/diasHabiles.service';
import { DIAS_ALQUILER_ANTES_RETIRO } from '../../../config/bot.config';
import { avisarSiguienteParadaRuta } from '../../viajes/viajes.routes';
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
          await sendText(to, `✅ ¡Buenísimo, ${chofer.nombre}! Ya te vinculamos el número. 🚚`);
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
          `🔒 Ese DNI ya tiene otro número de WhatsApp vinculado. Avisamos a un operador para que confirme el cambio antes de aplicarlo.`,
        );
        return;
      }
      // No coincide: derivar a operador
      const [alerta] = await query(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('chofer_no_reconocido', $1, $2) RETURNING id, tipo, referencia_id, mensaje, creado_en`,
        [to, `Chofer no reconocido (${to}) intentó validarse con DNI ${dni}`],
      );
      if (alerta) emitAlerta(alerta);
      await clearSesion(to);
      await sendText(
        to,
        '🙁 Ese DNI no nos cierra. Ya avisamos a un operador para que te contacte y te dé una mano.',
      );
      return;
    }
    // Primer contacto: pedir DNI
    await setSesion({ telefono: to, flujo: 'chofer', paso: 'esperando_dni', contexto: {} });
    await sendText(to, '🚚 ¡Hola! No tengo este número registrado. Pasame tu *DNI* para validarte como chofer.');
    return;
  }

  // 2) Chofer reconocido: manejar cambio de estado (botones), elección de
  // contenedor (lista), y las dos acciones self-service nuevas (vaciado y
  // autoasignación del vacío de un recambio).
  if (m.tipo === 'interactive_button' && m.seleccionId?.startsWith('estado:')) {
    return elegirContenedor(to, chofer[0].id, m.seleccionId.replace('estado:', ''), sesion);
  }
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('cont:')) {
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
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('recgrupo:')) {
    return elegirVacioRecambio(to, chofer[0].id, m.seleccionId.replace('recgrupo:', ''));
  }
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('recvacio:') && sesion.paso === 'elegir_vacio_recambio') {
    return aplicarVacioRecambio(to, chofer[0].id, chofer[0].nombre, m.seleccionId.replace('recvacio:', ''), sesion);
  }
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('claim:')) {
    return reclamarTrabajo(to, chofer[0].id, chofer[0].nombre, m.seleccionId.replace('claim:', ''));
  }

  // Soporte para respuestas por texto libre o si el cliente no usa botones interactivos
  const txt = (m.texto ?? '').toLowerCase().trim();
  if (txt.includes('retir')) {
    return elegirContenedor(to, chofer[0].id, 'retirado', sesion);
  }
  if (txt.includes('entreg')) {
    return elegirContenedor(to, chofer[0].id, 'entregado', sesion);
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
 * Menú principal del chofer: 3 botones pegados al mensaje (un solo toque),
 * en vez de una lista desplegable — más rápido para alguien manejando.
 * Se manda después de cada acción para que nunca tenga que escribir "menú".
 *
 * Si además el chofer tiene contenedores propios en "retirado" esperando
 * confirmar el vaciado, o un recambio propio esperando que le asigne el
 * vacío, se mandan listas aparte con esas acciones — WhatsApp permite un
 * máximo de 3 botones por mensaje, por eso no se pueden agregar ahí mismo.
 */
export async function menuChofer(to: string, nombre?: string): Promise<void> {
  await sendButtons(
    to,
    nombre ? `🚚 ¡Hola, ${nombre}! ¿Qué querés registrar?` : '🚚 Panel del chofer. ¿Qué querés registrar?',
    ESTADOS_CHOFER.map((e) => ({ id: `estado:${e}`, title: LABEL_ESTADO[e] })),
  );

  const [chofer] = await query<{ id: string }>(
    'SELECT id FROM choferes WHERE telefono = $1 AND activo = TRUE',
    [to],
  );
  if (!chofer) return; // no debería pasar (ya se validó identidad antes de llegar acá)
  await ofrecerVaciadosPendientes(to, chofer.id);
  await ofrecerRecambioPendiente(to, chofer.id);
  await ofrecerTrabajosSinAsignar(to);
}

/**
 * Retiros y recambios que todavía no tienen chofer asignado — CUALQUIER
 * chofer los puede tomar por WhatsApp, no hace falta que un operador se lo
 * asigne primero desde el panel (así, un recambio recién pedido por un
 * cliente ya se puede empezar a trabajar apenas alguien lo toma).
 */
async function ofrecerTrabajosSinAsignar(to: string): Promise<void> {
  const pendientes = await query<{ id: string; contenedor_numero: string; grupo_id: string | null; destino_direccion: string | null }>(
    `SELECT id, contenedor_numero, grupo_id, destino_direccion
       FROM viajes
      WHERE tipo = 'retiro' AND chofer_id IS NULL AND estado IN ('programado', 'en_curso')
        AND contenedor_numero IS NOT NULL
      ORDER BY creado_en LIMIT 10`,
  );
  if (pendientes.length === 0) return;
  await sendList(
    to,
    '📋 Sin asignar',
    'Hay retiros/recambios sin chofer — ¿tomás alguno?',
    'Ver trabajos',
    pendientes.map((p) => ({
      id: `claim:${p.id}`,
      title: p.contenedor_numero,
      description: p.grupo_id
        ? `🔄 Es un recambio${p.destino_direccion ? ` — ${p.destino_direccion}` : ''}`
        : p.destino_direccion ?? undefined,
    })),
  );
}

/**
 * El chofer toma un trabajo sin asignar: se convierte en el chofer de esa
 * fila (y de su pareja, si es un recambio) — mismo efecto que si un
 * operador lo hubiera asignado desde el panel, incluido el aviso normal.
 */
async function reclamarTrabajo(to: string, choferId: string, choferNombre: string, viajeId: string): Promise<void> {
  const [choferRow] = await query<{ patente: string | null }>('SELECT patente FROM choferes WHERE id = $1', [choferId]);
  // Guard WHERE chofer_id IS NULL: si otro chofer lo tomó justo antes, no se lo pisamos.
  const [viaje] = await query<{ id: string; grupo_id: string | null; contenedor_numero: string }>(
    `UPDATE viajes SET chofer_id = $2, patente = $3
      WHERE id = $1 AND chofer_id IS NULL AND estado IN ('programado', 'en_curso')
      RETURNING id, grupo_id, contenedor_numero`,
    [viajeId, choferId, choferRow?.patente ?? null],
  );
  if (!viaje) {
    await sendText(to, '🙁 Ese trabajo ya no está disponible — puede que otro chofer ya lo haya tomado.');
    return menuChofer(to, choferNombre);
  }
  if (viaje.grupo_id) {
    // Recambio: la pata "entrega" (el vacío) queda con el mismo chofer.
    await query(
      `UPDATE viajes SET chofer_id = $2, patente = $3
        WHERE grupo_id = $1 AND tipo = 'entrega' AND chofer_id IS NULL`,
      [viaje.grupo_id, choferId, choferRow?.patente ?? null],
    );
  }
  emitRecursoActualizado('contenedores');
  emitRecursoActualizado('viajes');
  await sendText(to, `✅ ¡Listo! Te asignamos el contenedor *${viaje.contenedor_numero}*. 💪`);
  return menuChofer(to, choferNombre);
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
    '🗑️ Vaciado',
    '¿Ya vaciaste alguno de estos contenedores?',
    'Ver contenedores',
    pendientes.map((p) => ({ id: `vaciado:${p.contenedor_numero}`, title: p.contenedor_numero })),
  );
}

/** Recambios propios (ya tiene asignado el retiro del lleno) esperando que diga con qué vacío completa la entrega. */
async function ofrecerRecambioPendiente(to: string, choferId: string): Promise<void> {
  const pendientes = await query<{ entrega_id: string; lleno_numero: string }>(
    `SELECT e.id AS entrega_id, r.contenedor_numero AS lleno_numero
       FROM viajes r
       JOIN viajes e ON e.grupo_id = r.grupo_id AND e.tipo = 'entrega' AND e.contenedor_numero IS NULL
        AND e.estado IN ('programado', 'en_curso')
      WHERE r.chofer_id = $1 AND r.tipo = 'retiro' AND r.grupo_id IS NOT NULL
        AND r.estado IN ('programado', 'en_curso')
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
    `¿Cuál contenedor vacío dejás para completar el recambio del lleno *${llenoNumero}*? Al elegirlo se marca todo junto: el vacío queda entregado y el lleno retirado, yendo a vaciar.`,
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
    await sendText(to, '🙁 No hay ningún contenedor vacío disponible ahora mismo.');
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
    await sendText(to, `⚠️ No pudimos registrar el vaciado de ${numero}: ${resultado.error}`);
  }
  return menuChofer(to, choferNombre);
}

/**
 * Si `numero` es parte de un recambio (grupo_id) y su pareja (el otro
 * contenedor del mismo recambio) ya está lista para transicionar, la marca
 * en el mismo momento. Se llama SIEMPRE que un contenedor pasa a 'entregado'
 * o 'retirado' — así no importa si el vacío se asignó desde el panel o por
 * WhatsApp, ni cuál de los dos lados toca el chofer primero: el otro sigue
 * solo. Devuelve un texto para sumar al mensaje de confirmación, o '' si no
 * había pareja o todavía no estaba lista (ej. el vacío aún no se asignó).
 */
async function cascadearParejaRecambio(numero: string, choferId: string, choferNombre: string): Promise<string> {
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
    await query(`UPDATE contenedores SET estado = 'entregado', actualizado_por = $2 WHERE numero = $1`, [pareja.contenedor_numero, `chofer:${choferId}`]);
    await query(`UPDATE viajes SET completada_en = now() WHERE id = $1`, [pareja.id]);
    avisarSiguienteParadaRuta(pareja.id).catch((e) => console.error('Error avisando siguiente parada:', e.message));
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
  avisarSiguienteParadaRuta(pareja.id).catch((e) => console.error('Error avisando siguiente parada:', e.message));
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
      await sendText(to, `🙁 El contenedor ${numero} ya no está disponible — alguien lo tomó justo antes. Probá con otro.`);
      return menuChofer(to, choferNombre);
    }

    const [choferRow] = await query<{ patente: string | null }>('SELECT patente FROM choferes WHERE id = $1', [choferId]);
    const [viajeEntrega] = await query<{ fecha: string }>(
      `UPDATE viajes SET contenedor_numero = $1, chofer_id = $2, patente = $3
        WHERE id = $4 AND contenedor_numero IS NULL RETURNING fecha`,
      [numero, choferId, choferRow?.patente ?? null, entregaId],
    );

    // 'reservado' -> 'entregado' directo (mismo trigger que usa cualquier
    // entrega): el chofer ya se lo está dejando al cliente en este momento.
    await query(`UPDATE contenedores SET estado = 'entregado', actualizado_por = $2 WHERE numero = $1`, [numero, `chofer:${choferId}`]);
    // El vencimiento es la fecha de entrega + los días de alquiler estándar
    // (mismo criterio que cotizacion.flow.ts al calcular fecha_retiro_estimada)
    // — no la fecha de entrega misma, que dejaría el contenedor "vencido"
    // el mismo día que se lo deja.
    if (viajeEntrega) {
      const venceEn = sumarDias(viajeEntrega.fecha, DIAS_ALQUILER_ANTES_RETIRO);
      await query(`UPDATE contenedores SET vence_en = $2::date WHERE numero = $1`, [numero, venceEn]);
    }
    await query(`UPDATE viajes SET completada_en = now() WHERE id = $1`, [entregaId]);
    avisarSiguienteParadaRuta(entregaId).catch((e) => console.error('Error avisando siguiente parada:', e.message));

    const mensajeLleno = await cascadearParejaRecambio(numero, choferId, choferNombre);

    emitRecursoActualizado('contenedores');
    emitRecursoActualizado('viajes');
    await sendText(
      to,
      `✅ ¡Recambio completado! Dejaste *${numero}*${mensajeLleno}. ${mensajeLleno ? 'Avisame por acá cuando vacíes el lleno (🗑️ en el menú). ' : ''}¡Gracias por tu trabajo! 🙌`,
    );
  } catch (err: any) {
    await sendText(to, `⚠️ No pudimos completar el recambio con ${numero}. Probá de nuevo.`);
    console.error('Error en aplicarVacioRecambio:', err.message);
  }
  return menuChofer(to, choferNombre);
}

/** Tras elegir estado, listar contenedores candidatos. */
async function elegirContenedor(to: string, choferId: string, estado: string, sesion: Sesion): Promise<void> {
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
  const conts = await query<{ numero: string; grupo_id: string | null; tipo: string; pareja_numero: string | null; pareja_tipo: string | null }>(
    `SELECT DISTINCT ON (c.numero)
            c.numero, v.grupo_id, v.tipo, pareja.contenedor_numero AS pareja_numero, pareja.tipo AS pareja_tipo
       FROM contenedores c
       JOIN viajes v ON v.contenedor_numero = c.numero
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
      LIMIT 10`,
    [origen, choferId, tipoRequerido],
  );
  if (conts.length === 0) {
    await sendText(to, `🙁 No tengo contenedores en estado "${origen}" para pasar a "${estado.replace('_', ' ')}".`);
    return menuChofer(to);
  }
  await setSesion({ telefono: to, flujo: 'chofer', paso: 'elegir_contenedor', contexto: { estado } });
  await sendList(
    to,
    LABEL_ESTADO[estado as keyof typeof LABEL_ESTADO],
    '¿Cuál contenedor?',
    'Ver contenedores',
    conts.map((c) => ({
      id: `cont:${estado}:${c.numero}`,
      title: c.numero,
      description: c.grupo_id
        ? c.pareja_tipo === 'retiro'
          ? `🔄 Recambio — retira el lleno ${c.pareja_numero}`
          : `🔄 Recambio — entrega el vacío ${c.pareja_numero}`
        : undefined,
    })),
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
        await sendText(to, `🙁 El contenedor ${numero} no tiene ningún retiro pedido todavía — no se puede marcar como retirado.`);
        await clearSesion(to);
        return menuChofer(to, choferNombre);
      }
      const retiroId = retiroExistente.id;
      await query(
        `UPDATE viajes SET estado = 'en_curso', completada_en = now(),
                chofer_id = COALESCE(chofer_id, $2),
                destino_direccion = COALESCE(destino_direccion, $3),
                zona = COALESCE(zona, $4),
                ubicacion_id = COALESCE(ubicacion_id, $5),
                ubicacion_direccion = COALESCE(ubicacion_direccion, $6)
          WHERE id = $1`,
        [retiroExistente.id, choferId, entrega?.destino_direccion ?? null, entrega?.zona ?? null, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
      );
      avisarSiguienteParadaRuta(retiroId).catch((e) => console.error('Error avisando siguiente parada:', e.message));
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
      const extraVacio = await cascadearParejaRecambio(numero, choferId, choferNombre);
      emitRecursoActualizado('contenedores');
      emitRecursoActualizado('viajes');
      await clearSesion(to);
      await sendText(
        to,
        `📥 ¡Anotado! Contenedor *${numero}* marcado como retirado${extraVacio}. Avisame por acá cuando lo vacíes (🗑️ en el menú). ¡Gracias por tu trabajo! 🙌`,
      );
    } catch (err: any) {
      await sendText(to, `⚠️ No pudimos registrar el retiro de ${numero}. Probá de nuevo.`);
      console.error('Error registrando retiro pendiente:', err.message);
    }
    return menuChofer(to, choferNombre);
  }

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
      await sendText(to, `🙁 No tenés una entrega asignada para el contenedor ${numero}.`);
      await clearSesion(to);
      return menuChofer(to, choferNombre);
    }
    // El trigger fn_validar_transicion_contenedor rechaza transiciones ilegales.
    await query(
      'UPDATE contenedores SET estado = $1, actualizado_por = $2 WHERE numero = $3',
      [estado, `chofer:${choferId}`, numero],
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
    if (estado === 'entregado') {
      const entregasCompletadas = await query<{ id: string }>(
        `UPDATE viajes SET completada_en = now()
          WHERE contenedor_numero = $1 AND chofer_id = $2 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso')
          RETURNING id`,
        [numero, choferId],
      );
      for (const v of entregasCompletadas) {
        avisarSiguienteParadaRuta(v.id).catch((e) => console.error('Error avisando siguiente parada:', e.message));
      }
    }
    // Si esto es el vacío de un recambio y el lleno pareja ya está listo
    // (entregado), se retira en el mismo momento (yendo a vaciar) — así no
    // importa si el chofer marca primero el vacío o el lleno.
    const extra = await cascadearParejaRecambio(numero, choferId, choferNombre);
    await clearSesion(to);
    await sendText(to, `✅ ¡Listo! Contenedor *${numero}* marcado como *${estado.replace('_', ' ')}*${extra}. 💪`);
  } catch (err: any) {
    // Error de transición inválida u otro
    await sendText(
      to,
      `⚠️ No pude aplicar el cambio en ${numero}. Puede que el contenedor no esté en el estado correcto.`,
    );
    console.error('Error aplicarEstado:', err.message);
  }
  return menuChofer(to, choferNombre);
}
