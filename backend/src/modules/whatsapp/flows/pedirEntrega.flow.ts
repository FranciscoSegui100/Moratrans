import { query } from '../../../config/db';
import { sendText, sendButtons, sendLocationRequest } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import { reverseGeocode, CandidatoDireccion } from '../../../services/geocoding.service';
import { OPCIONES_HORARIO, pedirHorarioPreferido } from './horarioPreferido.flow';
import { manejarRespuestaInvalida } from '../estados';
import { verificarUbicacionCompleta, buscarCandidatosDireccion, enviarListaCandidatos, elegirCandidato } from './ubicacionZona.helper';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Los clientes de cuenta corriente pueden pedir que les entreguen un
 * contenedor directo por WhatsApp, sin pasar por cotización/pago (eso es
 * justamente lo que distingue a la cuenta corriente — se factura después,
 * no por adelantado). Para el resto de los clientes se los redirige a
 * *Cotizar*, que sí exige el pago antes de reservar contenedor.
 *
 * Ubicación: aplica capas 2 y 3 de la verificación (ver
 * ubicacionZona.helper.ts) — valida contra el polígono de departamentos y
 * deriva a un asesor si cae fuera de todas las zonas conocidas, sin cobrar
 * nada (cuenta corriente no cotiza acá). La capa 4 se mantiene simple (sí/no)
 * a propósito, para no sumarle fricción a un cliente ya aprobado.
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
  if (sesion.paso === 'horario_entrega_cliente') {
    return manejarHorario(m, sesion);
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

  await setSesion({ telefono: to, flujo: 'pedir_entrega', paso: 'esperando_direccion_entrega', contexto: {} });
  await sendLocationRequest(
    to,
    '📍 ¿A qué dirección llevamos el contenedor? Tocá "Enviar ubicación" o escribila primero (después igual te pido el pin).',
  );
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
      contextoPedidoFueraDeZona: { tipo: 'entrega' },
    });
    if (!resultado.ok) return;

    await pedirConfirmacion(to, sesion, m.lat, m.lng, destinoDireccion);
    return;
  }

  if (m.tipo === 'text' && m.texto && m.texto.trim().length >= 5) {
    const resultado = await buscarCandidatosDireccion(m.texto.trim());

    if (resultado.tipo === 'sin_resultados') {
      await sendText(
        to,
        '🙁 No encontramos esa dirección. Probá describirla distinto (calle + altura + localidad), ' +
          'o directamente tocá el botón de "Enviar ubicación" para mandar el pin.',
      );
      return;
    }
    if (resultado.tipo === 'un_candidato') {
      await sendLocationRequest(
        to,
        `📍 Encontramos: ${resultado.candidato.direccion}.\n\n` +
          'Ahora sí, compartí tu ubicación GPS parada en el lugar exacto de entrega — no alcanza con escribirla.',
      );
      await setSesion({
        telefono: to,
        flujo: 'pedir_entrega',
        paso: 'esperando_direccion_entrega',
        contexto: { destinoDireccionReferencia: resultado.candidato.direccion },
      });
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

  await sendText(to, '📍 Necesito la dirección: tocá "Enviar ubicación" o escribila en un mensaje.');
}

async function manejarEleccionCandidato(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const candidatos = (sesion.contexto.candidatos as CandidatoDireccion[]) ?? [];

  const elegido = elegirCandidato(m, candidatos);
  if (!elegido) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una de las direcciones de la lista. 👆');
    return;
  }

  await sendLocationRequest(
    to,
    `📍 Anotado como referencia: ${elegido.direccion}.\n\n` +
      'Ahora sí, compartí tu ubicación GPS parada en el lugar exacto de entrega — tocá "Enviar ubicación". No alcanza con escribirla.',
  );
  await setSesion({
    telefono: to,
    flujo: 'pedir_entrega',
    paso: 'esperando_direccion_entrega',
    contexto: { destinoDireccionReferencia: elegido.direccion },
  });
}

async function pedirConfirmacion(
  to: string,
  sesion: Sesion,
  destinoLat: number,
  destinoLng: number,
  destinoDireccion: string | null,
): Promise<void> {
  const resumen = `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`;

  await sendButtons(to, `📍 Confirmá la dirección de entrega:\n\n${resumen}\n\n¿Es correcta?`, [
    { id: 'entrega_cliente_si', title: '✅ Sí, es correcta' },
    { id: 'entrega_cliente_no', title: '↩️ Volver a enviar' },
  ]);
  await setSesion({
    telefono: to,
    flujo: 'pedir_entrega',
    paso: 'confirmar_entrega_cliente',
    contexto: { destinoDireccion, destinoLat, destinoLng },
  });
}

async function manejarConfirmacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'entrega_cliente_no') {
    await setSesion({ telefono: to, flujo: 'pedir_entrega', paso: 'esperando_direccion_entrega', contexto: {} });
    await sendLocationRequest(to, '📍 Dale, mandámela de nuevo: tocá "Enviar ubicación" o escribí la dirección.');
    return;
  }
  if (m.seleccionId !== 'entrega_cliente_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, es correcta" o "↩️ Volver a enviar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }

  await pedirHorarioPreferido(to, '🕐 ¿En qué franja horaria preferís que te lo llevemos?');
  await setSesion({ telefono: to, flujo: 'pedir_entrega', paso: 'horario_entrega_cliente', contexto: sesion.contexto });
}

async function manejarHorario(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const opcion = OPCIONES_HORARIO.find((o) => o.id === m.seleccionId);
  if (!opcion) {
    await pedirHorarioPreferido(to, 'Elegí una de las opciones de abajo. 👇');
    return;
  }

  const destinoDireccion = sesion.contexto.destinoDireccion as string | null;
  const destinoLat = (sesion.contexto.destinoLat as number | null) ?? null;
  const destinoLng = (sesion.contexto.destinoLng as number | null) ?? null;

  // Depósito de donde sale el contenedor (si hay uno solo activo cargado; si
  // hay varios, se completa después desde el panel — mismo criterio que el
  // resto de los flujos del bot, ver ubicaciones.service.ts).
  const deposito = await resolverUbicacion('deposito');

  const [viaje] = await query<{ id: string }>(
    `INSERT INTO viajes (tipo, fecha, cliente_telefono, destino_direccion, destino_lat, destino_lng, horario_preferido, estado, notas, ubicacion_id, ubicacion_direccion)
     VALUES ('entrega', CURRENT_DATE, $1, $2, $3, $4, $5, 'programado', 'Pedido de entrega por WhatsApp (cuenta corriente)', $6, $7)
     RETURNING id`,
    [to, destinoDireccion, destinoLat, destinoLng, opcion.title, deposito?.id ?? null, deposito?.direccion ?? null],
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
      '_Si en un rato no tenés novedades, escribí *asesor*._',
  );
}
