import { query } from '../../../config/db';
import { sendText, sendButtons, sendList, sendLocationRequest } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import { reverseGeocode } from '../../../services/geocoding.service';
import { proximosDiasHabiles, formatearFechaLarga } from '../../../services/diasHabiles.service';
import { OPCIONES_HORARIO, pedirHorarioPreferido } from './horarioPreferido.flow';
import { manejarRespuestaInvalida } from '../estados';
import {
  pedirDepartamento,
  departamentoElegido,
  pedirMetodoUbicacion,
  mensajePedirCalleNumero,
  verificarUbicacionConDepartamentoElegido,
  preguntarMismatchDepartamento,
  resolverUbicacionMensaje,
  mensajePedirUbicacionPasoAPaso,
  combinarDireccionConIndicacion,
  normalizarIndicacion,
} from './ubicacionZona.helper';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/** Próximos días que se le ofrecen a un cliente de cuenta corriente para elegir la entrega (sin domingos). */
const DIAS_A_OFRECER_ENTREGA_CC = 3;

/**
 * Los clientes de cuenta corriente pueden pedir que les entreguen un
 * contenedor directo por WhatsApp, sin pasar por cotización/pago (eso es
 * justamente lo que distingue a la cuenta corriente — se factura después,
 * no por adelantado). Para el resto de los clientes se los redirige a
 * *Cotizar*, que sí exige el pago antes de reservar contenedor.
 *
 * Pasos: elegir_departamento_entrega -> elegir_metodo_ubicacion_entrega ->
 * [ubicacion_pin_entrega [-> confirmar_departamento_pin_entrega, si el pin
 * no coincide con el departamento elegido] | ubicacion_texto_entrega] ->
 * confirmar_entrega_cliente -> indicacion_entrega_cliente ->
 * dia_entrega_cliente -> horario_entrega_cliente -> confirmar_resumen_entrega
 * -> [crea el viaje].
 *
 * Mismo criterio que cotizacion.flow.ts (ver comentario ahí): se elige
 * departamento primero, después pin (prioritario, verificado por geometría
 * real — si no coincide, el cliente decide) o calle/número escritos a mano
 * sin buscar en el mapa (marcados `direccion_verificada = false` — el
 * propio cliente la confirma, resaltada en negrita, en la capa 4). Acá SÍ
 * se exige tarifa activa (`requiereTarifa: true`) en el pin: aunque cuenta
 * corriente no paga en el momento, el costo de cada entrega se muestra al
 * cliente y se guarda en `viajes.importe`.
 */
export async function handlePedirEntrega(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'elegir_departamento_entrega') {
    return manejarDepartamento(m, sesion);
  }
  if (sesion.paso === 'elegir_metodo_ubicacion_entrega') {
    return manejarMetodoUbicacion(m, sesion);
  }
  if (sesion.paso === 'ubicacion_pin_entrega') {
    return manejarUbicacionPin(m, sesion);
  }
  if (sesion.paso === 'confirmar_departamento_pin_entrega') {
    return manejarMismatchDepartamento(m, sesion);
  }
  if (sesion.paso === 'ubicacion_texto_entrega') {
    return manejarUbicacionTexto(m, sesion);
  }
  if (sesion.paso === 'confirmar_entrega_cliente') {
    return manejarConfirmacion(m, sesion);
  }
  if (sesion.paso === 'indicacion_entrega_cliente') {
    return manejarIndicacion(m, sesion);
  }
  if (sesion.paso === 'dia_entrega_cliente') {
    return manejarDia(m, sesion);
  }
  if (sesion.paso === 'horario_entrega_cliente') {
    return manejarHorario(m, sesion);
  }
  if (sesion.paso === 'confirmar_resumen_entrega') {
    return manejarConfirmacionResumen(m, sesion);
  }

  const [cliente] = await query<{ cuenta_corriente_estado: string }>(
    'SELECT cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [to],
  );
  if (cliente?.cuenta_corriente_estado !== 'aprobada') {
    await clearSesion(to);
    await sendText(
      to,
      '📦 Pedir una entrega directa es para clientes con *cuenta corriente aprobada*.\n\n' +
        'Escribí *Cotizar* para pedir un flete y pagarlo por transferencia, o *asesor* si creés que ya deberías tener cuenta corriente.',
    );
    return;
  }

  await iniciarPedidoDireccion(to);
}

async function iniciarPedidoDireccion(to: string): Promise<void> {
  if (!(await pedirDepartamento(to, '¡Genial! Elegí el *departamento* de destino:'))) {
    await clearSesion(to);
    return;
  }
  await setSesion({ telefono: to, flujo: 'pedir_entrega', paso: 'elegir_departamento_entrega', contexto: {} });
}

async function manejarDepartamento(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = departamentoElegido(m);
  if (!departamento) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una opción de la lista.\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  await setSesion({ ...sesion, paso: 'elegir_metodo_ubicacion_entrega', contexto: { departamento } });
  await pedirMetodoUbicacion(to, departamento);
}

async function manejarMetodoUbicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = sesion.contexto.departamento as string;

  if (m.seleccionId === 'metodo_pin') {
    await setSesion({ ...sesion, paso: 'ubicacion_pin_entrega' });
    await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Mandanos el pin de la dirección en *${departamento}*.`));
    return;
  }
  if (m.seleccionId === 'metodo_texto') {
    await setSesion({ ...sesion, paso: 'ubicacion_texto_entrega' });
    await sendText(to, mensajePedirCalleNumero(departamento));
    return;
  }
  await manejarRespuestaInvalida(m, 'Por favor, elegí una de las opciones que te mostramos arriba. 👆');
}

async function manejarUbicacionPin(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = sesion.contexto.departamento as string;
  const ubicacion = await resolverUbicacionMensaje(m);

  if (ubicacion.tipo === 'ubicacion') {
    const destinoDireccion = ubicacion.direccionCruda ?? (await reverseGeocode(ubicacion.lat, ubicacion.lng));

    const resultado = await verificarUbicacionConDepartamentoElegido(m, sesion, ubicacion.lat, ubicacion.lng, destinoDireccion, departamento, {
      requiereTarifa: true,
      contextoPedidoFueraDeZona: { tipo: 'entrega' },
    });
    if (!resultado.ok) return;

    if (!resultado.coincide) {
      await preguntarMismatchDepartamento(to, resultado.departamentoElegido, resultado.departamentoDetectado);
      await setSesion({
        ...sesion,
        paso: 'confirmar_departamento_pin_entrega',
        contexto: { departamento, departamentoDetectado: resultado.departamentoDetectado, destinoLat: ubicacion.lat, destinoLng: ubicacion.lng, destinoDireccion },
      });
      return;
    }

    await pedirConfirmacion(to, sesion, ubicacion.lat, ubicacion.lng, destinoDireccion, resultado.departamento, resultado.tarifa, true);
    return;
  }

  if (ubicacion.tipo === 'link_invalido') {
    await sendText(to, '🙁 No pude leer ese link de Maps. Probá copiarlo de nuevo desde el botón "Compartir", o usá el botón "Enviar ubicación" que te mostramos arriba.');
    return;
  }

  await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Mandanos el pin de la dirección en *${departamento}*.`));
}

async function manejarMismatchDepartamento(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const { departamento, departamentoDetectado, destinoLat, destinoLng, destinoDireccion } = sesion.contexto as {
    departamento: string;
    departamentoDetectado: string;
    destinoLat: number;
    destinoLng: number;
    destinoDireccion: string | null;
  };

  if (m.seleccionId === 'depto_reenviar') {
    await setSesion({ ...sesion, paso: 'ubicacion_pin_entrega', contexto: { departamento } });
    await sendLocationRequest(to, mensajePedirUbicacionPasoAPaso(`📍 Dale, mandanos de nuevo el pin de la dirección en *${departamento}*.`));
    return;
  }
  if (m.seleccionId !== 'depto_cambiar') {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una de las opciones que te mostramos arriba. 👆');
    return;
  }

  const [tarifa] = await query<{ precio: string }>(
    'SELECT precio FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [departamentoDetectado],
  );
  if (!tarifa) {
    await sendText(to, `🙁 No tenemos tarifa activa en *${departamentoDetectado}* todavía. Escribí *asesor* para coordinarlo.`);
    await clearSesion(to);
    return;
  }
  await pedirConfirmacion(to, sesion, destinoLat, destinoLng, destinoDireccion, departamentoDetectado, tarifa, true);
}

async function manejarUbicacionTexto(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const departamento = sesion.contexto.departamento as string;

  if (m.tipo !== 'text' || !m.texto || m.texto.trim().length < 4) {
    await sendText(to, mensajePedirCalleNumero(departamento));
    return;
  }

  const [tarifa] = await query<{ precio: string }>(
    'SELECT precio FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [departamento],
  );
  if (!tarifa) {
    await sendText(to, `🙁 No tenemos tarifa activa en *${departamento}* todavía. Escribí *asesor* para coordinarlo.`);
    await clearSesion(to);
    return;
  }
  await pedirConfirmacion(to, sesion, null, null, m.texto.trim(), departamento, tarifa, false);
}

async function pedirConfirmacion(
  to: string,
  sesion: Sesion,
  destinoLat: number | null,
  destinoLng: number | null,
  destinoDireccion: string | null,
  departamento: string,
  tarifa: { precio: string } | null,
  direccionVerificada: boolean,
): Promise<void> {
  const resumen =
    destinoLat != null && destinoLng != null
      ? `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`
      : `*${destinoDireccion}*`;
  const lineaPrecio = tarifa ? `\nCosto: *ARS ${Number(tarifa.precio).toLocaleString('es-AR')}*` : '';

  await sendButtons(
    to,
    `📍 Confirmá la dirección de entrega:\n\n${resumen}\nZona: *${departamento}*${lineaPrecio}\n\n¿Confirmás que esta es la dirección exacta donde debe entregarse el contenedor?`,
    [
      { id: 'entrega_cliente_si', title: '✅ Sí, es correcta' },
      { id: 'entrega_cliente_no', title: '↩️ Volver a enviar' },
    ],
  );
  await setSesion({
    telefono: to,
    flujo: 'pedir_entrega',
    paso: 'confirmar_entrega_cliente',
    contexto: { destinoDireccion, destinoLat, destinoLng, departamento, direccionVerificada, precio: tarifa?.precio ?? null },
  });
}

async function manejarConfirmacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'entrega_cliente_no') {
    const departamento = sesion.contexto.departamento as string;
    await setSesion({ telefono: to, flujo: 'pedir_entrega', paso: 'elegir_metodo_ubicacion_entrega', contexto: { departamento } });
    await pedirMetodoUbicacion(to, departamento);
    return;
  }
  if (m.seleccionId !== 'entrega_cliente_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, es correcta" o "↩️ Volver a enviar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }

  await sendText(
    to,
    '🚚 ¿Alguna indicación para el chofer que le facilite llegar (portón, timbre, entre calles, un punto de referencia)?\n\n' +
      'Si no hay ninguna, escribí *no*.',
  );
  await setSesion({ ...sesion, paso: 'indicacion_entrega_cliente' });
}

async function manejarIndicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'text' || !m.texto) {
    await sendText(to, '🚚 Contame si hay alguna indicación para el chofer, o escribí *no*.');
    return;
  }
  const indicacion = normalizarIndicacion(m.texto);
  const destinoDireccion = combinarDireccionConIndicacion(sesion.contexto.destinoDireccion as string | null, indicacion);
  await pedirDiaEntrega(to, { ...sesion, contexto: { ...sesion.contexto, destinoDireccion } });
}

async function pedirDiaEntrega(to: string, sesion: Sesion): Promise<void> {
  const dias = proximosDiasHabiles(DIAS_A_OFRECER_ENTREGA_CC);
  await sendList(
    to,
    '📅 Día de entrega',
    '¿Qué día preferís que te llevemos el contenedor?',
    'Ver días',
    dias.map((d) => ({ id: `dia:${d.fecha}`, title: d.etiqueta })),
  );
  await setSesion({ ...sesion, paso: 'dia_entrega_cliente' });
}

async function manejarDia(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (!m.seleccionId?.startsWith('dia:')) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí uno de los días de la lista. 👆');
    return;
  }
  const fechaEntrega = m.seleccionId.replace('dia:', '');
  await pedirHorarioPreferido(to, `🕐 ¿En qué franja horaria preferís que te lo llevemos el ${formatearFechaLarga(fechaEntrega)}?`);
  await setSesion({ ...sesion, paso: 'horario_entrega_cliente', contexto: { ...sesion.contexto, fechaEntrega } });
}

async function manejarHorario(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const opcion = OPCIONES_HORARIO.find((o) => o.id === m.seleccionId);
  if (!opcion) {
    await pedirHorarioPreferido(to, 'Por favor, elegí una de las siguientes opciones. 👇');
    return;
  }

  const { destinoDireccion, destinoLat, destinoLng, departamento, precio, fechaEntrega } = sesion.contexto as {
    destinoDireccion: string | null;
    destinoLat: number | null;
    destinoLng: number | null;
    departamento: string;
    precio: string | null;
    fechaEntrega: string;
  };

  const lineaPrecio = precio ? `\nCosto: *ARS ${Number(precio).toLocaleString('es-AR')}*` : '';
  await sendButtons(
    to,
    `📦 *Resumen del pedido*\n\n` +
      `Dirección: ${destinoDireccion ?? `ubicación compartida (${destinoLat}, ${destinoLng})`}\n` +
      `Zona: *${departamento}*${lineaPrecio}\n` +
      `Fecha de entrega: ${formatearFechaLarga(fechaEntrega)}\n` +
      `Franja horaria: ${opcion.title}\n\n` +
      `¿Está todo correcto?`,
    [
      { id: 'resumen_entrega_si', title: '✅ Sí, confirmar' },
      { id: 'resumen_entrega_no', title: '↩️ Corregir' },
    ],
  );
  await setSesion({ ...sesion, paso: 'confirmar_resumen_entrega', contexto: { ...sesion.contexto, horarioPreferido: opcion.title } });
}

async function manejarConfirmacionResumen(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'resumen_entrega_no') {
    await clearSesion(to);
    await sendText(to, '👍 Sin problema, no quedó nada guardado. Escribí *Pedir contenedor* cuando quieras volver a intentarlo.');
    return;
  }
  if (m.seleccionId !== 'resumen_entrega_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, confirmar" o "↩️ Corregir".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }

  const { destinoDireccion, destinoLat, destinoLng, departamento, direccionVerificada, precio, horarioPreferido, fechaEntrega } = sesion.contexto as {
    destinoDireccion: string | null;
    destinoLat: number | null;
    destinoLng: number | null;
    departamento: string;
    direccionVerificada: boolean;
    precio: string | null;
    horarioPreferido: string;
    fechaEntrega: string;
  };

  // Depósito de donde sale el contenedor (si hay uno solo activo cargado; si
  // hay varios, se completa después desde el panel — mismo criterio que el
  // resto de los flujos del bot, ver ubicaciones.service.ts).
  const deposito = await resolverUbicacion('deposito');

  const [viaje] = await query<{ id: string }>(
    `INSERT INTO viajes (tipo, fecha, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, direccion_verificada, horario_preferido, importe, es_cuenta_corriente, estado, notas, ubicacion_id, ubicacion_direccion)
     VALUES ('entrega', $1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, 'programado', $10, $11, $12)
     RETURNING id`,
    [
      fechaEntrega, to, departamento, destinoDireccion, destinoLat, destinoLng, direccionVerificada, horarioPreferido, precio,
      'Pedido de entrega por WhatsApp (cuenta corriente).',
      deposito?.id ?? null, deposito?.direccion ?? null,
    ],
  );

  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('entrega_solicitada', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [viaje.id, `${to} pidió una entrega por cuenta corriente`],
  );
  if (alerta) emitAlerta({ ...alerta, cliente_telefono: to });
  emitRecursoActualizado('viajes');

  await clearSesion(to);
  await sendText(
    to,
    '✅ ¡Listo! Registramos tu pedido de entrega. En breve te asignamos contenedor y chofer.\n\n' +
      '¡Gracias por confiar en *MoraTrans*! 🚚\n\n' +
      '_Para ver el detalle y el total pendiente de tu cuenta, escribí *Resumen de cuenta* en el menú. ' +
      'Si en un rato no tenés novedades, escribí *asesor*._',
  );
}
