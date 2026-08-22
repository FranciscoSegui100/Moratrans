import { query } from '../../../config/db';
import { sendText, sendButtons, sendList, downloadMedia } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { encrypt, encryptBuffer } from '../../../services/crypto.service';
import { subirArchivo } from '../../../services/storage.service';
import { contenedoresDelCliente, ContenedorCliente } from '../../../services/contenedorCliente.service';
import { datosBancarios, opcionesMetodoPago, tieneCuentaCorrienteAprobada } from './pago.flow';
import { manejarRespuestaInvalida } from '../estados';
import { escalarAAsesor } from './asesor.flow';
import { DIAS_ALARGUE, COSTO_ALARGUE_FIJO } from '../../../config/bot.config';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * "Alargar retiro": un cliente que ya tiene un contenedor entregado paga un
 * costo fijo (ver bot.config.ts) para sumar 5 días más al vencimiento. Sigue
 * el mismo circuito que cualquier pago (comprobante + validación de un
 * operador, o cuenta corriente si la tiene) — la extensión recién se aplica
 * cuando se valida, ver POST /api/pagos/:id/validar. Solo se puede pedir UNA
 * vez por ciclo (desde la última entrega/recambio del contenedor); si el
 * cliente quiere más, se deriva a un asesor en vez de dejarlo repetir.
 */
export async function handleAlargarRetiro(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'elegir_contenedor_alargue') return manejarEleccionContenedor(m, sesion);
  if (sesion.paso === 'confirmar_alargue') return manejarConfirmacion(m, sesion);
  if (sesion.paso === 'elegir_metodo_alargue') return manejarMetodo(m, sesion);
  if (sesion.paso === 'esperando_comprobante_alargue') return manejarComprobante(m, sesion);

  const conts = await contenedoresDelCliente(to);
  if (conts.length === 0) {
    await clearSesion(to);
    await sendText(
      to,
      '🙁 No encontramos ningún contenedor entregado a tu nombre en este momento. Escribí *asesor* si creés que es un error.',
    );
    return;
  }
  if (conts.length === 1) return pedirConfirmacion(to, conts[0], sesion);
  await setSesion({ telefono: to, flujo: 'alargar_retiro', paso: 'elegir_contenedor_alargue', contexto: {} });
  await sendList(
    to,
    '⏳ Alargar retiro',
    'Tenés más de un contenedor con nosotros — ¿cuál querés alargar?',
    'Ver contenedores',
    conts.map((c) => ({ id: `alarg:${c.numero}`, title: c.numero })),
  );
}

async function manejarEleccionContenedor(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'interactive_list' || !m.seleccionId?.startsWith('alarg:')) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí uno de la lista de arriba. 👆');
    return;
  }
  const numero = m.seleccionId.replace('alarg:', '');
  const cont = (await contenedoresDelCliente(to)).find((c) => c.numero === numero);
  if (!cont) {
    await clearSesion(to);
    await sendText(to, '🙁 Ese contenedor ya no está disponible. Escribí *menú* para volver a empezar.');
    return;
  }
  await pedirConfirmacion(to, cont, sesion);
}

/**
 * ¿Ya se usó el alargue en el ciclo actual de este contenedor? El "ciclo"
 * arranca en la última entrega/recambio (viaje tipo 'entrega' más reciente,
 * no cancelado) — un recambio nuevo abre un ciclo nuevo, así que vuelve a
 * habilitar la extensión.
 */
async function yaUsoElAlargueEsteCiclo(numero: string): Promise<boolean> {
  const [ultimaEntrega] = await query<{ creado_en: string }>(
    `SELECT creado_en FROM viajes WHERE contenedor_numero = $1 AND tipo = 'entrega' AND estado <> 'cancelado' ORDER BY creado_en DESC LIMIT 1`,
    [numero],
  );
  const desde = ultimaEntrega?.creado_en ?? '1970-01-01';
  const [existente] = await query<{ id: string }>(
    `SELECT id FROM pagos WHERE contenedor_numero = $1 AND tipo = 'alargue_retiro' AND estado <> 'rechazado' AND creado_en >= $2 LIMIT 1`,
    [numero, desde],
  );
  return !!existente;
}

async function pedirConfirmacion(to: string, cont: ContenedorCliente, sesion: Sesion): Promise<void> {
  if (await yaUsoElAlargueEsteCiclo(cont.numero)) {
    await escalarAAsesor(
      to,
      sesion,
      `${to} quiere extender de nuevo el retiro del contenedor ${cont.numero} (ya usó su extensión de este ciclo)`,
    );
    return;
  }

  await setSesion({
    telefono: to,
    flujo: 'alargar_retiro',
    paso: 'confirmar_alargue',
    contexto: { numero: cont.numero, costo: COSTO_ALARGUE_FIJO },
  });
  await sendButtons(
    to,
    `⏳ Extender *${DIAS_ALARGUE} días* más el retiro del contenedor *${cont.numero}* cuesta *ARS ${COSTO_ALARGUE_FIJO.toLocaleString('es-AR')}*.\n\n` +
      'Solo se puede pedir una vez por contenedor. ¿Confirmás?',
    [
      { id: 'alargue_si', title: '✅ Sí, confirmar' },
      { id: 'alargue_no', title: '↩️ Cancelar' },
    ],
  );
}

async function manejarConfirmacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'alargue_no') {
    await clearSesion(to);
    await sendText(to, '👍 Listo, no pedimos el alargue. Escribí *menú* si necesitás algo más.');
    return;
  }
  if (m.seleccionId !== 'alargue_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, confirmar" o "↩️ Cancelar".');
    return;
  }
  await setSesion({ ...sesion, paso: 'elegir_metodo_alargue' });
  await sendButtons(to, '💳 ¿Cómo vas a pagar el alargue?', await opcionesMetodoPago(to));
}

async function manejarMetodo(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (m.seleccionId === 'metodo_cuenta_corriente') {
    if (!(await tieneCuentaCorrienteAprobada(to))) {
      await sendButtons(to, 'Esa opción no está disponible para vos — elegí transferencia. 👇', await opcionesMetodoPago(to));
      return;
    }
    return registrarAlargue(to, sesion, { esCuentaCorriente: true });
  }

  if (m.seleccionId === 'metodo_transferencia') {
    await setSesion({ ...sesion, paso: 'esperando_comprobante_alargue' });
    await sendText(
      to,
      `${datosBancarios()}\n\n` +
        '💸 Transferí y mandame por acá la *foto o PDF* del comprobante.\n\n' +
        '_Escribí *menú* si te arrepentiste y querés volver al inicio._',
    );
    return;
  }

  await sendButtons(to, 'Elegí una de las opciones de abajo. 👇', await opcionesMetodoPago(to));
}

async function manejarComprobante(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'image' && m.tipo !== 'document') {
    await sendText(to, '📎 Necesito una imagen o PDF del comprobante para poder registrarlo. ¿Podés reenviarlo?');
    return;
  }

  try {
    const { buffer, mime } = await downloadMedia(m.mediaId!);
    const ext = mime.includes('pdf') ? 'pdf' : mime.split('/')[1] || 'jpg';
    const filename = `${to}_${Date.now()}.${ext}`;
    const rutaStorage = `comprobantes/${filename}`;
    await subirArchivo(encryptBuffer(buffer), rutaStorage, 'application/octet-stream');
    const rutaCifrada = encrypt(rutaStorage);
    await registrarAlargue(to, sesion, { rutaCifrada, mediaId: m.mediaId ?? null });
  } catch (err) {
    console.error('Error en flujo de alargue:', err);
    await sendText(to, '⚠️ Tuvimos un problema al procesar el comprobante. Probá reenviarlo en unos minutos.');
  }
}

async function registrarAlargue(
  to: string,
  sesion: Sesion,
  pago: { esCuentaCorriente?: boolean; rutaCifrada?: string; mediaId?: string | null },
): Promise<void> {
  const numero = sesion.contexto.numero as string;
  const costo = sesion.contexto.costo as number;
  const moneda = 'ARS';

  const [row] = await query<{ id: string }>(
    `INSERT INTO pagos (cliente_telefono, tipo, contenedor_numero, monto, url_comprobante, media_id, es_cuenta_corriente, estado)
     VALUES ($1, 'alargue_retiro', $2, $3, $4, $5, $6, 'pendiente')
     RETURNING id`,
    [to, numero, costo, pago.rutaCifrada ?? null, pago.mediaId ?? null, !!pago.esCuentaCorriente],
  );

  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('alargue_solicitado', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [row.id, `${to} pidió alargar ${DIAS_ALARGUE} días el contenedor ${numero} (${moneda ?? ''} ${costo})`],
  );
  if (alerta) {
    emitAlerta({
      ...alerta,
      cliente_telefono: to,
      monto: costo,
      pago_estado: 'pendiente',
      tiene_comprobante: !!pago.rutaCifrada,
      moneda,
    });
  }
  emitRecursoActualizado('pagos');

  await clearSesion(to);
  await sendText(
    to,
    '✅ ¡Recibido! Tu pedido para alargar el retiro quedó *pendiente de validación* por un operador.\n\n' +
      '_Si en un rato no tenés novedades, escribí *asesor*._',
  );
}
