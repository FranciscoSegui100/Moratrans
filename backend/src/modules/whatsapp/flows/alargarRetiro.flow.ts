import { query } from '../../../config/db';
import { sendText, sendButtons, sendList, downloadMedia } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { encrypt, encryptBuffer } from '../../../services/crypto.service';
import { subirArchivo } from '../../../services/storage.service';
import { contenedoresDelCliente, ContenedorCliente } from '../../../services/contenedorCliente.service';
import { datosBancarios, opcionesMetodoPago, tieneCuentaCorrienteAprobada } from './pago.flow';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/** Fijo: no se le pregunta al cliente cuántos días — siempre son 5. */
const DIAS_ALARGUE = 5;

/**
 * "Alargar retiro": un cliente que ya tiene un contenedor entregado paga el
 * 50% de su último pago validado para sumar 5 días más al vencimiento. Sigue
 * el mismo circuito que cualquier pago (comprobante + validación de un
 * operador, o cuenta corriente si la tiene) — la extensión recién se aplica
 * cuando se valida, ver POST /api/pagos/:id/validar.
 */
export async function handleAlargarRetiro(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'elegir_contenedor_alargue') return manejarEleccionContenedor(m);
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
  if (conts.length === 1) return pedirConfirmacion(to, conts[0]);
  await setSesion({ telefono: to, flujo: 'alargar_retiro', paso: 'elegir_contenedor_alargue', contexto: {} });
  await sendList(
    to,
    '⏳ Alargar retiro',
    'Tenés más de un contenedor con nosotros — ¿cuál querés alargar?',
    'Ver contenedores',
    conts.map((c) => ({ id: `alarg:${c.numero}`, title: c.numero })),
  );
}

async function manejarEleccionContenedor(m: MensajeEntrante): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'interactive_list' || !m.seleccionId?.startsWith('alarg:')) {
    await sendText(to, 'Por favor, elegí uno de la lista de arriba. 👆');
    return;
  }
  const numero = m.seleccionId.replace('alarg:', '');
  const cont = (await contenedoresDelCliente(to)).find((c) => c.numero === numero);
  if (!cont) {
    await clearSesion(to);
    await sendText(to, '🙁 Ese contenedor ya no está disponible. Escribí *menú* para volver a empezar.');
    return;
  }
  await pedirConfirmacion(to, cont);
}

/** El 50% del monto del último pago validado de este cliente (cualquier contenedor). */
async function calcularCosto(telefono: string): Promise<{ costo: number; moneda: string | null } | null> {
  const [ultimo] = await query<{ precio: string; moneda: string | null }>(
    `SELECT pe.precio, td.moneda
       FROM pagos p
       JOIN pedidos pe ON pe.id = p.pedido_id
       LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
      WHERE p.cliente_telefono = $1 AND p.estado = 'validado' AND p.tipo = 'flete' AND pe.precio IS NOT NULL
      ORDER BY p.creado_en DESC LIMIT 1`,
    [telefono],
  );
  if (!ultimo) return null;
  const costo = Math.round(Number(ultimo.precio) * 0.5 * 100) / 100;
  return { costo, moneda: ultimo.moneda };
}

async function pedirConfirmacion(to: string, cont: ContenedorCliente): Promise<void> {
  const base = await calcularCosto(to);
  if (!base) {
    await clearSesion(to);
    await sendText(
      to,
      '🙁 No pudimos calcular el costo del alargue automáticamente (no encontramos un pago anterior validado). Escribí *asesor* para coordinarlo.',
    );
    return;
  }
  await setSesion({
    telefono: to,
    flujo: 'alargar_retiro',
    paso: 'confirmar_alargue',
    contexto: { numero: cont.numero, costo: base.costo, moneda: base.moneda },
  });
  await sendButtons(
    to,
    `⏳ Extender *${DIAS_ALARGUE} días* más el retiro del contenedor *${cont.numero}* cuesta *${base.moneda ?? ''} ${base.costo.toLocaleString('es-AR')}*` +
      ' (50% de tu último pago).\n\n¿Confirmás?',
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
    await sendText(to, 'Elegí "✅ Sí, confirmar" o "↩️ Cancelar".');
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
  const moneda = (sesion.contexto.moneda as string | null) ?? null;

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
