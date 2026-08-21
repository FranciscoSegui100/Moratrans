import { query } from '../../../config/db';
import { sendText, sendButtons, sendLocationRequest } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { resolverUbicacion } from '../../../services/ubicaciones.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Los clientes de cuenta corriente pueden pedir que les entreguen un
 * contenedor directo por WhatsApp, sin pasar por cotización/pago (eso es
 * justamente lo que distingue a la cuenta corriente — se factura después,
 * no por adelantado). Para el resto de los clientes se los redirige a
 * *Cotizar*, que sí exige el pago antes de reservar contenedor.
 */
export async function handlePedirEntrega(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'esperando_direccion_entrega') {
    return manejarDireccion(m, sesion);
  }
  if (sesion.paso === 'confirmar_entrega_cliente') {
    return manejarConfirmacion(m, sesion);
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
    '📍 ¿A qué dirección llevamos el contenedor? Tocá "Enviar ubicación" o escribila (ej: _Av. San Martín 1234, Barrio Centro_).',
  );
}

async function manejarDireccion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  let destinoLat: number | null = null;
  let destinoLng: number | null = null;
  let destinoDireccion: string | null = null;

  if (m.tipo === 'location') {
    destinoLat = m.lat ?? null;
    destinoLng = m.lng ?? null;
    destinoDireccion = m.ubicacionDireccion || m.ubicacionNombre || null;
  } else if (m.tipo === 'text' && m.texto && m.texto.trim().length >= 5) {
    destinoDireccion = m.texto.trim();
  } else {
    await sendText(to, '📍 Necesito la dirección: tocá "Enviar ubicación" o escribila en un mensaje.');
    return;
  }

  const resumen =
    destinoLat != null && destinoLng != null
      ? `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`
      : (destinoDireccion as string);

  await sendButtons(to, `📍 Confirmá la dirección de entrega:\n\n${resumen}\n\n¿Es correcta?`, [
    { id: 'entrega_cliente_si', title: '✅ Sí, es correcta' },
    { id: 'entrega_cliente_no', title: '↩️ Volver a enviar' },
  ]);
  await setSesion({
    telefono: to,
    flujo: 'pedir_entrega',
    paso: 'confirmar_entrega_cliente',
    contexto: { destinoDireccion },
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
    await sendText(to, 'Elegí "✅ Sí, es correcta" o "↩️ Volver a enviar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }

  const destinoDireccion = sesion.contexto.destinoDireccion as string | null;

  // Depósito de donde sale el contenedor (si hay uno solo activo cargado; si
  // hay varios, se completa después desde el panel — mismo criterio que el
  // resto de los flujos del bot, ver ubicaciones.service.ts).
  const deposito = await resolverUbicacion('deposito');

  const [viaje] = await query<{ id: string }>(
    `INSERT INTO viajes (tipo, fecha, cliente_telefono, destino_direccion, estado, notas, ubicacion_id, ubicacion_direccion)
     VALUES ('entrega', CURRENT_DATE, $1, $2, 'programado', 'Pedido de entrega por WhatsApp (cuenta corriente)', $3, $4)
     RETURNING id`,
    [to, destinoDireccion, deposito?.id ?? null, deposito?.direccion ?? null],
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
