import { randomUUID } from 'crypto';
import { query } from '../../../config/db';
import { sendText, sendButtons, sendList } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { contenedoresDelCliente, ContenedorCliente } from '../../../services/contenedorCliente.service';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Recambio: el chofer deja un contenedor vacío y se lleva el lleno en la
 * misma visita, sin que el cliente tenga que esperar un viaje aparte para
 * cada cosa. Se modela como dos filas de `viajes` (una 'retiro' del lleno +
 * una 'entrega' del vacío, sin contenedor asignado todavía) unidas por
 * grupo_id — el operador completa la entrega (contenedor + chofer) desde el
 * panel, igual que hace hoy con cualquier entrega nueva.
 */
export async function handleRecambio(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'elegir_contenedor_recambio') {
    return manejarEleccionContenedor(m);
  }
  if (sesion.paso === 'confirmar_recambio') {
    return manejarConfirmacion(m, sesion);
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
  await setSesion({ telefono: to, flujo: 'recambio', paso: 'elegir_contenedor_recambio', contexto: {} });
  await sendList(
    to,
    '🔄 Recambio',
    'Tenés más de un contenedor con nosotros — ¿cuál querés recambiar?',
    'Ver contenedores',
    conts.map((c) => ({ id: `rec:${c.numero}`, title: c.numero })),
  );
}

async function manejarEleccionContenedor(m: MensajeEntrante): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'interactive_list' || !m.seleccionId?.startsWith('rec:')) {
    await sendText(to, 'Por favor, elegí uno de la lista de arriba. 👆');
    return;
  }
  const numero = m.seleccionId.replace('rec:', '');
  const cont = (await contenedoresDelCliente(to)).find((c) => c.numero === numero);
  if (!cont) {
    await clearSesion(to);
    await sendText(to, '🙁 Ese contenedor ya no está disponible para recambio. Escribí *menú* para volver a empezar.');
    return;
  }
  await pedirConfirmacion(to, cont);
}

async function pedirConfirmacion(to: string, cont: ContenedorCliente): Promise<void> {
  await setSesion({
    telefono: to,
    flujo: 'recambio',
    paso: 'confirmar_recambio',
    contexto: { numero: cont.numero, zona: cont.zona, destinoDireccion: cont.destino_direccion },
  });
  await sendButtons(
    to,
    `🔄 ¿Confirmás el recambio del contenedor *${cont.numero}*?\nVamos a coordinar que un chofer te deje uno vacío y se lleve el lleno.`,
    [
      { id: 'recambio_si', title: '✅ Sí, confirmar' },
      { id: 'recambio_no', title: '↩️ Cancelar' },
    ],
  );
}

async function manejarConfirmacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'recambio_no') {
    await clearSesion(to);
    await sendText(to, '👍 Listo, no pedimos el recambio. Escribí *menú* si necesitás algo más.');
    return;
  }
  if (m.seleccionId !== 'recambio_si') {
    await sendText(to, 'Elegí "✅ Sí, confirmar" o "↩️ Cancelar".');
    return;
  }

  const numero = sesion.contexto.numero as string;
  const zona = (sesion.contexto.zona as string | null) ?? null;
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;
  const grupoId = randomUUID();

  // Vaciadero adonde se lleva el lleno (si hay uno solo activo cargado; si
  // hay varios, queda sin asignar y se completa después desde el panel —
  // mismo criterio que el contenedor de la fila 'entrega', más abajo).
  const vaciadero = await resolverUbicacion('vaciadero');

  await query(
    `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, grupo_id, ubicacion_id, ubicacion_direccion)
     VALUES ('retiro', CURRENT_DATE, $1, $2, $3, $4, 'Recambio: retira el lleno', $5, $6, $7)`,
    [numero, to, zona, destino, grupoId, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
  );
  // La fecha del retiro ES el vencimiento del lleno: cuándo se espera que vuelva.
  await query(`UPDATE contenedores SET vence_en = CURRENT_DATE WHERE numero = $1`, [numero]);
  const deposito = await resolverUbicacion('deposito');
  await query(
    `INSERT INTO viajes (tipo, fecha, cliente_telefono, zona, destino_direccion, notas, grupo_id, ubicacion_id, ubicacion_direccion)
     VALUES ('entrega', CURRENT_DATE, $1, $2, $3, 'Recambio: deja un vacío', $4, $5, $6)`,
    [to, zona, destino, grupoId, deposito?.id ?? null, deposito?.direccion ?? null],
  );

  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('recambio_solicitado', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [grupoId, `${to} pidió recambio del contenedor ${numero}`],
  );
  if (alerta) emitAlerta({ ...alerta, cliente_telefono: to });
  emitRecursoActualizado('viajes');

  await clearSesion(to);
  await sendText(
    to,
    `✅ ¡Listo! Coordinamos el recambio del contenedor *${numero}*. Te avisamos por acá cuándo pasa el chofer.\n\n` +
      '_Si en un rato no tenés novedades, escribí *asesor*._',
  );
}
