import { query } from '../../../config/db';
import { sendText, sendButtons, sendList, motivoErrorWa } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { contenedoresDelCliente, ContenedorCliente } from '../../../services/contenedorCliente.service';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import { proximosDiasHabiles, formatearFechaLarga } from '../../../services/diasHabiles.service';
import { manejarRespuestaInvalida } from '../estados';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * El cliente llenó el contenedor antes de lo previsto y pide que lo pasen a
 * buscar, eligiendo qué día — sin costo, no se descuenta del alquiler (a
 * diferencia de "cancelar retiro", que es otro caso). Si ya había un retiro
 * 'programado' para ese contenedor lo reprograma a la fecha elegida en vez
 * de duplicarlo; si no había ninguno, crea uno nuevo y alerta al panel para
 * que se le asigne chofer.
 */
export async function handlePedirRetiro(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'elegir_contenedor_retiro') {
    return manejarEleccion(m);
  }
  if (sesion.paso === 'confirmar_retiro_cliente') {
    return manejarConfirmacion(m, sesion);
  }
  if (sesion.paso === 'elegir_dia_retiro') {
    return manejarDia(m, sesion);
  }

  const conts = await contenedoresDelCliente(to);
  if (conts.length === 0) {
    await clearSesion(to);
    await sendText(
      to,
      '🙁 No encontramos ningún contenedor entregado a tu nombre en este momento. Escribí *asesor* si creés que es un error.',
    );
    return;
  }
  if (conts.length === 1) {
    return pedirConfirmacion(to, conts[0]);
  }
  await setSesion({ telefono: to, flujo: 'pedir_retiro', paso: 'elegir_contenedor_retiro', contexto: {} });
  await sendList(
    to,
    '📥 Pedir retiro',
    'Tenés más de un contenedor con nosotros — ¿cuál querés que retiremos?',
    'Ver contenedores',
    conts.map((c) => ({ id: `ret:${c.numero}`, title: c.numero })),
  );
}

async function manejarEleccion(m: MensajeEntrante): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'interactive_list' || !m.seleccionId?.startsWith('ret:')) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí uno de la lista de arriba. 👆\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  const numero = m.seleccionId.replace('ret:', '');
  const cont = (await contenedoresDelCliente(to)).find((c) => c.numero === numero);
  if (!cont) {
    await clearSesion(to);
    await sendText(to, '🙁 Ese contenedor ya no está disponible. Escribí *menú* para volver a empezar.');
    return;
  }
  await pedirConfirmacion(to, cont);
}

async function pedirConfirmacion(to: string, cont: ContenedorCliente): Promise<void> {
  await setSesion({
    telefono: to,
    flujo: 'pedir_retiro',
    paso: 'confirmar_retiro_cliente',
    contexto: { numero: cont.numero, zona: cont.zona, destinoDireccion: cont.destino_direccion },
  });
  await sendButtons(
    to,
    `📥 ¿Confirmás que querés que retiremos el contenedor *${cont.numero}*?\nAvisamos al equipo para coordinarlo a la brevedad.`,
    [
      { id: 'retiro_cliente_si', title: '✅ Sí, confirmar' },
      { id: 'retiro_cliente_no', title: '↩️ Cancelar' },
    ],
  );
}

async function manejarConfirmacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'retiro_cliente_no') {
    await clearSesion(to);
    await sendText(to, '👍 Listo, no pedimos el retiro. Escribí *menú* si necesitás algo más.');
    return;
  }
  if (m.seleccionId !== 'retiro_cliente_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, confirmar" o "↩️ Cancelar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }

  const dias = proximosDiasHabiles();
  await sendList(
    to,
    '📅 Día de retiro',
    '¿Qué día preferís que pasemos a buscarlo? Sin costo, no se descuenta de tu alquiler.',
    'Ver días',
    dias.map((d) => ({ id: `dia:${d.fecha}`, title: d.etiqueta })),
  );
  await setSesion({ ...sesion, paso: 'elegir_dia_retiro' });
}

async function manejarDia(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (!m.seleccionId?.startsWith('dia:')) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí uno de los días de la lista. 👆');
    return;
  }
  const fecha = m.seleccionId.replace('dia:', '');

  const numero = sesion.contexto.numero as string;
  const zona = (sesion.contexto.zona as string | null) ?? null;
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;

  // ¿Ya había un retiro para este contenedor? Se reprograma a la fecha
  // elegida en vez de duplicarlo (el índice único de alertas también evita
  // una segunda 'retiro_solicitado' abierta para el mismo contenedor).
  const [existente] = await query<{ id: string; estado: string; chofer_id: string | null }>(
    `SELECT id, estado, chofer_id FROM viajes
      WHERE contenedor_numero = $1 AND tipo = 'retiro' AND estado IN ('programado', 'en_curso')
      ORDER BY creado_en DESC LIMIT 1`,
    [numero],
  );

  if (existente?.estado === 'en_curso') {
    await clearSesion(to);
    await sendText(to, `🚚 Ya está en camino un chofer a buscar el contenedor *${numero}*. ¡Gracias!`);
    return;
  }

  let choferId: string | null = null;
  if (existente) {
    await query(`UPDATE viajes SET fecha = $1 WHERE id = $2`, [fecha, existente.id]);
    choferId = existente.chofer_id;
  } else {
    // Vaciadero adonde se lleva el lleno (si hay uno solo activo cargado; si
    // hay varios, queda sin asignar y se completa después desde el panel).
    const vaciadero = await resolverUbicacion('vaciadero');
    await query(
      `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, ubicacion_id, ubicacion_direccion)
       VALUES ('retiro', $1, $2, $3, $4, $5, 'Pedido de retiro por WhatsApp (cliente)', $6, $7)`,
      [fecha, numero, to, zona, destino, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
    );
    const [alerta] = await query(
      `INSERT INTO alertas (tipo, referencia_id, mensaje)
       VALUES ('retiro_solicitado', $1, $2)
       ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
       RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
      [numero, `${to} pidió que retiremos el contenedor ${numero} el ${fecha}`],
    );
    if (alerta) emitAlerta({ ...alerta, cliente_telefono: to });
  }
  emitRecursoActualizado('viajes');

  if (choferId) {
    const [chofer] = await query<{ telefono: string | null }>('SELECT telefono FROM choferes WHERE id = $1', [choferId]);
    if (chofer?.telefono) {
      sendText(
        chofer.telefono,
        `📥 El cliente pidió el retiro del contenedor *${numero}* para el ${formatearFechaLarga(fecha)}.`,
      ).catch((e) => console.error('Error avisando retiro adelantado al chofer:', motivoErrorWa(e)));
    }
  }

  await clearSesion(to);
  await sendText(
    to,
    `✅ ¡Listo! Coordinamos el retiro del contenedor *${numero}* para el *${formatearFechaLarga(fecha)}*.\n\n_Si en un rato no tenés novedades, escribí *asesor*._`,
  );
}
