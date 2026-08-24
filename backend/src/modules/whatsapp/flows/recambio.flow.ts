import { query } from '../../../config/db';
import { sendText, sendButtons, sendList, sendLocationRequest } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { contenedoresDelCliente, ContenedorCliente } from '../../../services/contenedorCliente.service';
import { datosBancarios } from './pago.flow';
import { reverseGeocode, CandidatoDireccion } from '../../../services/geocoding.service';
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

/**
 * Recambio: el chofer deja un contenedor vacío y se lleva el lleno en la
 * misma visita, sin que el cliente tenga que esperar un viaje aparte para
 * cada cosa. Se cobra igual que una entrega nueva (tarifa de la zona) — al
 * confirmar acá solo se registra un `pedido` (tipo='recambio', con el
 * contenedor lleno ya conocido) y se lo manda al mismo circuito de pago que
 * cualquier cotización; los dos viajes ('retiro' del lleno + 'entrega' del
 * vacío, unidos por grupo_id) recién se crean cuando un operador valida el
 * pago (ver pagos.routes.ts /validar).
 *
 * Ubicación: si la dirección ya registrada del contenedor sigue sirviendo,
 * se confirma con un sí/no simple (ya fue verificada en su momento). Si es
 * una dirección NUEVA, pasa por la misma verificación completa de 4 capas
 * que "Cotizar" (capas 2/3 vía ubicacionZona.helper.ts + capa 4 propia acá
 * abajo) — la zona se recalcula a partir del GPS nuevo, no se asume la del
 * contenedor viejo (si no, quedaría cobrando la tarifa de una zona distinta
 * a donde en verdad va el recambio).
 *
 * Pasos: (elegir_contenedor_recambio) -> confirmar_recambio ->
 * confirmar_ubicacion_recambio [-> ubicacion_recambio [-> elegir_candidato_direccion_recambio]
 * -> confirmar_ubicacion_recambio_nueva (capa 4)] -> horario_recambio -> pago.
 */
export async function handleRecambio(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'elegir_contenedor_recambio') {
    return manejarEleccionContenedor(m);
  }
  if (sesion.paso === 'confirmar_recambio') {
    return manejarConfirmacionContenedor(m, sesion);
  }
  if (sesion.paso === 'confirmar_ubicacion_recambio') {
    return manejarConfirmacionUbicacion(m, sesion);
  }
  if (sesion.paso === 'ubicacion_recambio') {
    return manejarNuevaUbicacion(m, sesion);
  }
  if (sesion.paso === 'elegir_candidato_direccion_recambio') {
    return manejarEleccionCandidato(m, sesion);
  }
  if (sesion.paso === 'confirmar_ubicacion_recambio_nueva') {
    return manejarConfirmacionUbicacionNueva(m, sesion);
  }
  if (sesion.paso === 'horario_recambio') {
    return manejarHorario(m, sesion);
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
    return pedirConfirmacionContenedor(to, conts[0]);
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
    await manejarRespuestaInvalida(m, 'Por favor, elegí uno de la lista de arriba. 👆\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  const numero = m.seleccionId.replace('rec:', '');
  const cont = (await contenedoresDelCliente(to)).find((c) => c.numero === numero);
  if (!cont) {
    await clearSesion(to);
    await sendText(to, '🙁 Ese contenedor ya no está disponible para recambio. Escribí *menú* para volver a empezar.');
    return;
  }
  await pedirConfirmacionContenedor(to, cont);
}

async function pedirConfirmacionContenedor(to: string, cont: ContenedorCliente): Promise<void> {
  await setSesion({
    telefono: to,
    flujo: 'recambio',
    paso: 'confirmar_recambio',
    contexto: {
      numero: cont.numero,
      zona: cont.zona,
      destinoDireccion: cont.destino_direccion,
      destinoLat: cont.destino_lat,
      destinoLng: cont.destino_lng,
    },
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

async function manejarConfirmacionContenedor(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'recambio_no') {
    await clearSesion(to);
    await sendText(to, '👍 Listo, no pedimos el recambio. Escribí *menú* si necesitás algo más.');
    return;
  }
  if (m.seleccionId !== 'recambio_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, confirmar" o "↩️ Cancelar".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  await pedirConfirmacionUbicacion(to, sesion);
}

/**
 * Antes de cobrar, mostramos la dirección que ya tenemos registrada (de la
 * entrega activa de ese contenedor) y pedimos que la confirme — para no
 * errarle si el cliente se mudó o el chofer terminó dejándolo en otro lado.
 * Si confirma que sigue siendo la misma, no hace falta re-verificarla (ya
 * pasó por las 4 capas cuando se cargó esa entrega). Si no hay ninguna
 * guardada, o la corrige, pasa a pedir una dirección nueva.
 */
async function pedirConfirmacionUbicacion(to: string, sesion: Sesion): Promise<void> {
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;
  if (!destino) {
    await pedirUbicacionNueva(to, sesion);
    return;
  }
  await setSesion({ ...sesion, paso: 'confirmar_ubicacion_recambio' });
  await sendButtons(
    to,
    `📍 Vamos a coordinar el recambio en esta dirección:\n\n${destino}\n\n¿Sigue siendo correcta?`,
    [
      { id: 'ubicacion_recambio_si', title: '✅ Sí, es correcta' },
      { id: 'ubicacion_recambio_no', title: '↩️ Corregirla' },
    ],
  );
}

async function manejarConfirmacionUbicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'ubicacion_recambio_no') {
    await pedirUbicacionNueva(to, sesion);
    return;
  }
  if (m.seleccionId !== 'ubicacion_recambio_si') {
    await manejarRespuestaInvalida(m, 'Elegí "✅ Sí, es correcta" o "↩️ Corregirla".\n\n_Escribí *menú* para volver al inicio._');
    return;
  }
  await pedirHorarioPreferido(to, '🕐 ¿En qué franja horaria preferís que coordinemos el recambio?');
  await setSesion({ ...sesion, paso: 'horario_recambio' });
}

async function pedirUbicacionNueva(to: string, sesion: Sesion): Promise<void> {
  await setSesion({ ...sesion, paso: 'ubicacion_recambio' });
  await sendLocationRequest(to, mensajePedirUbicacion('📍 ¿Cuál es la dirección nueva?'));
}

async function manejarHorario(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const opcion = OPCIONES_HORARIO.find((o) => o.id === m.seleccionId);
  if (!opcion) {
    await pedirHorarioPreferido(m.from, 'Elegí una de las opciones de abajo. 👇');
    return;
  }
  await confirmarYPedirPago(m, { ...sesion, contexto: { ...sesion.contexto, horarioPreferido: opcion.title } });
}

/**
 * Dirección nueva para el recambio: pin GPS o dirección escrita, siempre se
 * ofrecen las dos (regla del dueño). Si escribe, la geocodificamos y usamos
 * esas coordenadas directo (avisando que es aproximada) — no se obliga a
 * mandar el pin después, aunque siga siendo la opción más precisa.
 */
async function manejarNuevaUbicacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (m.tipo === 'location' && m.lat != null && m.lng != null) {
    let destinoDireccion =
      m.ubicacionDireccion || m.ubicacionNombre || (sesion.contexto.destinoDireccionReferencia as string | undefined) || null;
    if (!destinoDireccion) {
      destinoDireccion = await reverseGeocode(m.lat, m.lng);
    }

    const numero = sesion.contexto.numero as string;
    const resultado = await verificarUbicacionCompleta(m, sesion, m.lat, m.lng, destinoDireccion, {
      requiereTarifa: true,
      contextoPedidoFueraDeZona: { tipo: 'recambio', contenedorRecambioNumero: numero },
    });
    if (!resultado.ok) return;

    // La zona se recalcula con la ubicación nueva — no se asume la del
    // contenedor viejo, podría ser una dirección en otro departamento con otra tarifa.
    await avanzarACapaCuatroRecambio(to, sesion, resultado.departamento, m.lat, m.lng, destinoDireccion);
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

    const numero = sesion.contexto.numero as string;
    if (resultado.tipo === 'un_candidato') {
      const r = await verificarUbicacionCompleta(m, sesion, resultado.candidato.lat, resultado.candidato.lng, resultado.candidato.direccion, {
        requiereTarifa: true,
        contextoPedidoFueraDeZona: { tipo: 'recambio', contenedorRecambioNumero: numero },
      });
      if (!r.ok) return;
      await avanzarACapaCuatroRecambio(to, sesion, r.departamento, resultado.candidato.lat, resultado.candidato.lng, resultado.candidato.direccion, AVISO_DIRECCION_APROXIMADA);
      return;
    }
    await enviarListaCandidatos(to, resultado.candidatos);
    await setSesion({
      ...sesion,
      paso: 'elegir_candidato_direccion_recambio',
      contexto: { ...sesion.contexto, candidatos: resultado.candidatos },
    });
    return;
  }

  await sendText(to, mensajePedirUbicacion('📍 Necesito la dirección nueva.'));
}

async function manejarEleccionCandidato(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const candidatos = (sesion.contexto.candidatos as CandidatoDireccion[]) ?? [];

  const elegido = elegirCandidato(m, candidatos);
  if (!elegido) {
    await manejarRespuestaInvalida(m, 'Por favor, elegí una de las direcciones de la lista. 👆');
    return;
  }

  const numero = sesion.contexto.numero as string;
  const resultado = await verificarUbicacionCompleta(m, sesion, elegido.lat, elegido.lng, elegido.direccion, {
    requiereTarifa: true,
    contextoPedidoFueraDeZona: { tipo: 'recambio', contenedorRecambioNumero: numero },
  });
  if (!resultado.ok) return;
  await avanzarACapaCuatroRecambio(to, sesion, resultado.departamento, elegido.lat, elegido.lng, elegido.direccion, AVISO_DIRECCION_APROXIMADA);
}

/** Capa 4 para dirección nueva: misma pregunta puntual que "Cotizar", ver cotizacion.flow.ts. */
async function avanzarACapaCuatroRecambio(
  to: string,
  sesion: Sesion,
  departamento: string,
  destinoLat: number,
  destinoLng: number,
  destinoDireccion: string | null,
  avisoExtra?: string,
): Promise<void> {
  const resumenUbicacion = `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`;

  await sendButtons(
    to,
    `${avisoExtra ? avisoExtra + '\n\n' : ''}📍 Dirección: ${resumenUbicacion}\nZona: *${departamento}*\n\n` +
      `¿Este es el lugar donde va el contenedor, o es desde donde me estás escribiendo?`,
    [
      { id: 'ubicacion_es_destino', title: '📍 Es el destino' },
      { id: 'ubicacion_no', title: '↩️ Mandar otra' },
    ],
  );
  await setSesion({
    ...sesion,
    paso: 'confirmar_ubicacion_recambio_nueva',
    contexto: { ...sesion.contexto, zona: departamento, destinoLat, destinoLng, destinoDireccion },
  });
}

async function manejarConfirmacionUbicacionNueva(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (m.seleccionId === 'ubicacion_no') {
    await pedirUbicacionNueva(to, sesion);
    return;
  }
  if (m.seleccionId !== 'ubicacion_es_destino') {
    await manejarRespuestaInvalida(
      m,
      'Elegí "📍 Es el destino" o "↩️ Mandar otra".\n\n_Escribí *menú* para volver al inicio._',
    );
    return;
  }

  await pedirHorarioPreferido(to, '🕐 ¿En qué franja horaria preferís que coordinemos el recambio?');
  await setSesion({ ...sesion, paso: 'horario_recambio' });
}

async function confirmarYPedirPago(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const numero = sesion.contexto.numero as string;
  const zona = (sesion.contexto.zona as string | null) ?? null;
  const destino = (sesion.contexto.destinoDireccion as string | null) ?? null;
  const destinoLat = (sesion.contexto.destinoLat as number | null) ?? null;
  const destinoLng = (sesion.contexto.destinoLng as number | null) ?? null;
  const horarioPreferido = (sesion.contexto.horarioPreferido as string | null) ?? null;

  if (!zona) {
    await clearSesion(to);
    await sendText(to, '🙁 No tenemos la zona cargada para ese contenedor. Escribí *asesor* para coordinar el recambio.');
    return;
  }

  const tarifa = await query<{ precio: string; moneda: string }>(
    'SELECT precio, moneda FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [zona],
  );
  if (tarifa.length === 0) {
    await clearSesion(to);
    await sendText(to, '🙁 No encontramos la tarifa para tu zona. Escribí *asesor* para coordinar el recambio.');
    return;
  }
  const { precio, moneda } = tarifa[0];

  await query(
    `INSERT INTO pedidos (cliente_telefono, cliente_nombre, zona, precio, estado, destino_direccion, destino_lat, destino_lng, horario_preferido, tipo, contenedor_recambio_numero)
     VALUES ($1,$2,$3,$4,'confirmado',$5,$6,$7,$8,'recambio',$9)`,
    [to, m.nombrePerfil ?? null, zona, precio, destino, destinoLat, destinoLng, horarioPreferido, numero],
  );

  await clearSesion(to);
  await sendText(
    to,
    `🔄 *Recambio — contenedor ${numero}*\n` +
      `Precio del flete: *${moneda} ${Number(precio).toLocaleString('es-AR')}*\n` +
      (destino ? `Dirección: ${destino}\n` : '') +
      (horarioPreferido ? `Franja horaria: ${horarioPreferido}\n` : '') +
      `\nPara coordinar el recambio, hacé el pago con estos datos:\n\n` +
      `${datosBancarios()}\n\n` +
      `Y enviános el comprobante por este chat 📎\n` +
      `(escribí *Ya pagué* o adjuntá directamente la foto/PDF).\n\n` +
      `_Escribí *menú* para volver al inicio en cualquier momento._`,
  );
}
