import { query } from '../../../config/db';
import { sendText, sendButtons, sendList, sendLocationRequest } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import { reverseGeocode, CandidatoDireccion } from '../../../services/geocoding.service';
import { proximosDiasHabiles, formatearFechaLarga } from '../../../services/diasHabiles.service';
import { OPCIONES_HORARIO, pedirHorarioPreferido } from './horarioPreferido.flow';
import { manejarRespuestaInvalida } from '../estados';
import {
  verificarUbicacionCompleta,
  buscarCandidatosDireccion,
  enviarListaCandidatos,
  elegirCandidato,
  mensajePedirUbicacion,
  AVISO_DIRECCION_APROXIMADA,
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
 * Pasos: esperando_direccion_entrega [-> elegir_candidato_direccion_entrega]
 * -> confirmar_entrega_cliente -> dia_entrega_cliente -> horario_entrega_cliente
 * -> titular_entrega_cliente -> confirmar_resumen_entrega -> [crea el viaje].
 *
 * Ubicación: capas 2 y 3 (ver ubicacionZona.helper.ts) — valida contra el
 * polígono de departamentos, deriva a un asesor si cae fuera de zona, y esta
 * vez SÍ exige tarifa activa (`requiereTarifa: true`): aunque cuenta
 * corriente no paga en el momento, el costo de cada entrega se muestra al
 * cliente y se guarda en `viajes.importe` para que el resumen de cuenta
 * (reportes.service.ts::excelClientes) lo refleje correctamente — antes no
 * se guardaba ni zona ni importe en el viaje, así que esas entregas quedaban
 * con esas columnas vacías en el Excel.
 */
export async function handlePedirEntrega(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'esperando_direccion_entrega') {
    return manejarDireccion(m, sesion);
  }
  if (sesion.paso === 'elegir_candidato_direccion_entrega') {
    return manejarEleccionCandidato(m, sesion);
  }
  if (sesion.paso === 'confirmar_entrega_cliente') {
    return manejarConfirmacion(m, sesion);
  }
  if (sesion.paso === 'dia_entrega_cliente') {
    return manejarDia(m, sesion);
  }
  if (sesion.paso === 'horario_entrega_cliente') {
    return manejarHorario(m, sesion);
  }
  if (sesion.paso === 'titular_entrega_cliente') {
    return manejarTitular(m, sesion);
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
  await setSesion({ telefono: to, flujo: 'pedir_entrega', paso: 'esperando_direccion_entrega', contexto: {} });
  await sendLocationRequest(to, mensajePedirUbicacion('📍 ¿A qué dirección llevamos el contenedor?'));
}

async function manejarDireccion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (m.tipo === 'location' && m.lat != null && m.lng != null) {
    let destinoDireccion =
      m.ubicacionDireccion || m.ubicacionNombre || (sesion.contexto.destinoDireccionReferencia as string | undefined) || null;
    if (!destinoDireccion) {
      destinoDireccion = await reverseGeocode(m.lat, m.lng);
    }

    const resultado = await verificarUbicacionCompleta(m, sesion, m.lat, m.lng, destinoDireccion, {
      requiereTarifa: true,
      contextoPedidoFueraDeZona: { tipo: 'entrega' },
    });
    if (!resultado.ok) return;

    await pedirConfirmacion(to, sesion, m.lat, m.lng, destinoDireccion, resultado.departamento, resultado.tarifa);
    return;
  }

  if (m.tipo === 'text' && m.texto && m.texto.trim().length >= 5) {
    const resultado = await buscarCandidatosDireccion(m.texto.trim());

    if (resultado.tipo === 'sin_resultados') {
      await sendText(
        to,
        '🙁 No encontramos esa dirección. Probá describirla distinto (calle + altura + localidad + departamento), ' +
          'o tocá el botón de "Enviar ubicación" para mandar el pin.',
      );
      return;
    }
    if (resultado.tipo === 'un_candidato') {
      const r = await verificarUbicacionCompleta(m, sesion, resultado.candidato.lat, resultado.candidato.lng, resultado.candidato.direccion, {
        requiereTarifa: true,
        contextoPedidoFueraDeZona: { tipo: 'entrega' },
      });
      if (!r.ok) return;
      await pedirConfirmacion(to, sesion, resultado.candidato.lat, resultado.candidato.lng, resultado.candidato.direccion, r.departamento, r.tarifa, AVISO_DIRECCION_APROXIMADA);
      return;
    }
    await enviarListaCandidatos(to, resultado.candidatos);
    await setSesion({
      telefono: to,
      flujo: 'pedir_entrega',
      paso: 'elegir_candidato_direccion_entrega',
      contexto: { candidatos: resultado.candidatos },
    });
    return;
  }

  await sendText(to, mensajePedirUbicacion('📍 Necesito la dirección.'));
}

async function manejarEleccionCandidato(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const candidatos = (sesion.contexto.candidatos as CandidatoDireccion[]) ?? [];

  const elegido = elegirCandidato(m, candidatos);
  if (!elegido) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una de las direcciones de la lista. 👆');
    return;
  }

  const resultado = await verificarUbicacionCompleta(m, sesion, elegido.lat, elegido.lng, elegido.direccion, {
    requiereTarifa: true,
    contextoPedidoFueraDeZona: { tipo: 'entrega' },
  });
  if (!resultado.ok) return;
  await pedirConfirmacion(to, sesion, elegido.lat, elegido.lng, elegido.direccion, resultado.departamento, resultado.tarifa, AVISO_DIRECCION_APROXIMADA);
}

async function pedirConfirmacion(
  to: string,
  sesion: Sesion,
  destinoLat: number,
  destinoLng: number,
  destinoDireccion: string | null,
  departamento: string,
  tarifa: { precio: string; moneda: string } | null,
  avisoExtra?: string,
): Promise<void> {
  const resumen = `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`;
  const lineaPrecio = tarifa ? `\nCosto: *${tarifa.moneda} ${Number(tarifa.precio).toLocaleString('es-AR')}*` : '';

  await sendButtons(
    to,
    `${avisoExtra ? avisoExtra + '\n\n' : ''}📍 Confirmá la dirección de entrega:\n\n${resumen}\nZona: *${departamento}*${lineaPrecio}\n\n¿Es correcta?`,
    [
      { id: 'entrega_cliente_si', title: '✅ Sí, es correcta' },
      { id: 'entrega_cliente_no', title: '↩️ Volver a enviar' },
    ],
  );
  await setSesion({
    telefono: to,
    flujo: 'pedir_entrega',
    paso: 'confirmar_entrega_cliente',
    contexto: { destinoDireccion, destinoLat, destinoLng, departamento, precio: tarifa?.precio ?? null, moneda: tarifa?.moneda ?? null },
  });
}

async function manejarConfirmacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'entrega_cliente_no') {
    await iniciarPedidoDireccion(to);
    return;
  }
  if (m.seleccionId !== 'entrega_cliente_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, es correcta" o "↩️ Volver a enviar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }

  await pedirDiaEntrega(to, sesion);
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
    await pedirHorarioPreferido(to, 'Elegí una de las opciones de abajo. 👇');
    return;
  }
  await sendText(to, '🙋 ¿A nombre de quién hacemos la reserva?');
  await setSesion({ ...sesion, paso: 'titular_entrega_cliente', contexto: { ...sesion.contexto, horarioPreferido: opcion.title } });
}

async function manejarTitular(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const titular = (m.texto ?? '').trim();
  if (m.tipo !== 'text' || titular.length < 2) {
    await manejarRespuestaInvalida(m, '🙋 Decime el nombre de la persona o empresa a nombre de quién hacemos la reserva.');
    return;
  }

  const { destinoDireccion, destinoLat, destinoLng, departamento, precio, moneda, fechaEntrega, horarioPreferido } = sesion.contexto as {
    destinoDireccion: string | null;
    destinoLat: number | null;
    destinoLng: number | null;
    departamento: string;
    precio: string | null;
    moneda: string | null;
    fechaEntrega: string;
    horarioPreferido: string;
  };

  const lineaPrecio = precio ? `\nCosto: *${moneda} ${Number(precio).toLocaleString('es-AR')}*` : '';
  await sendButtons(
    to,
    `📦 *Resumen del pedido*\n\n` +
      `A nombre de: ${titular}\n` +
      `Dirección: ${destinoDireccion ?? `ubicación compartida (${destinoLat}, ${destinoLng})`}\n` +
      `Zona: *${departamento}*${lineaPrecio}\n` +
      `Fecha de entrega: ${formatearFechaLarga(fechaEntrega)}\n` +
      `Franja horaria: ${horarioPreferido}\n\n` +
      `¿Está todo correcto?`,
    [
      { id: 'resumen_entrega_si', title: '✅ Sí, confirmar' },
      { id: 'resumen_entrega_no', title: '↩️ Corregir' },
    ],
  );
  await setSesion({ ...sesion, paso: 'confirmar_resumen_entrega', contexto: { ...sesion.contexto, titular } });
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

  const { destinoDireccion, destinoLat, destinoLng, departamento, precio, horarioPreferido, fechaEntrega, titular } = sesion.contexto as {
    destinoDireccion: string | null;
    destinoLat: number | null;
    destinoLng: number | null;
    departamento: string;
    precio: string | null;
    horarioPreferido: string;
    fechaEntrega: string;
    titular: string;
  };

  // Depósito de donde sale el contenedor (si hay uno solo activo cargado; si
  // hay varios, se completa después desde el panel — mismo criterio que el
  // resto de los flujos del bot, ver ubicaciones.service.ts).
  const deposito = await resolverUbicacion('deposito');

  const [viaje] = await query<{ id: string }>(
    `INSERT INTO viajes (tipo, fecha, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, horario_preferido, importe, es_cuenta_corriente, estado, notas, ubicacion_id, ubicacion_direccion)
     VALUES ('entrega', $1, $2, $3, $4, $5, $6, $7, $8, TRUE, 'programado', $9, $10, $11)
     RETURNING id`,
    [
      fechaEntrega, to, departamento, destinoDireccion, destinoLat, destinoLng, horarioPreferido, precio,
      `Pedido de entrega por WhatsApp (cuenta corriente). Solicitado por: ${titular}`,
      deposito?.id ?? null, deposito?.direccion ?? null,
    ],
  );

  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('entrega_solicitada', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [viaje.id, `${to} pidió una entrega por cuenta corriente (a nombre de ${titular})`],
  );
  if (alerta) emitAlerta({ ...alerta, cliente_telefono: to });
  emitRecursoActualizado('viajes');

  await clearSesion(to);
  await sendText(
    to,
    '✅ ¡Listo! Registramos tu pedido de entrega. En breve te asignamos contenedor y chofer.\n\n' +
      '_Para ver el detalle y el total pendiente de tu cuenta, escribí *Resumen de cuenta* en el menú. ' +
      'Si en un rato no tenés novedades, escribí *asesor*._',
  );
}
