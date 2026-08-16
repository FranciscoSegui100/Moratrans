import { query } from '../../../config/db';
import { sendText, sendList, sendButtons, sendLocationRequest } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { datosBancarios } from './pago.flow';
import { obtenerOCrearCliente } from '../../../services/clientes.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Flujo de cotización (menú cerrado):
 *   inicio -> elegir_departamento -> confirmar -> ubicacion -> [precio]
 * Las tarifas se consultan SIEMPRE desde tarifas_departamento.
 */
export async function handleCotizacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  // Paso 0: mostrar la lista de departamentos activos.
  if (!sesion.paso || sesion.paso === 'inicio') {
    const deptos = await query<{ departamento: string }>(
      'SELECT departamento FROM tarifas_departamento WHERE activo = TRUE ORDER BY departamento LIMIT 10',
    );
    if (deptos.length === 0) {
      await sendText(to, '🙁 No tenemos tarifas cargadas por el momento. Escribí *asesor* y te ayudamos igual.');
      await clearSesion(to);
      return;
    }
    await sendList(
      to,
      '🧮 Cotización de flete',
      '¡Genial! Elegí el *departamento* de destino:',
      'Ver departamentos',
      deptos.map((d) => ({ id: `depto:${d.departamento}`, title: d.departamento })),
    );
    await setSesion({ ...sesion, flujo: 'cotizacion', paso: 'elegir_departamento', contexto: {} });
    return;
  }

  // Paso 1: recibió la selección del departamento -> pedir confirmación explícita.
  if (sesion.paso === 'elegir_departamento') {
    if (!m.seleccionId?.startsWith('depto:')) {
      await sendText(to, 'Por favor, elegí una opción de la lista.');
      return;
    }
    const departamento = m.seleccionId.replace('depto:', '');
    await sendButtons(
      to,
      `📍 Elegiste *${departamento}*. ¿Confirmamos este destino para cotizar?`,
      [
        { id: 'confirmar_depto', title: '✅ Sí, confirmar' },
        { id: 'cancelar_depto', title: '↩️ Elegir otro' },
      ],
    );
    await setSesion({ ...sesion, paso: 'confirmar', contexto: { departamento } });
    return;
  }

  // Paso 2: confirmación del departamento -> ahora pedimos la ubicación de entrega.
  if (sesion.paso === 'confirmar') {
    if (m.seleccionId === 'cancelar_depto') {
      await setSesion({ ...sesion, paso: 'inicio', contexto: {} });
      return handleCotizacion(m, { ...sesion, paso: 'inicio', contexto: {} });
    }
    if (m.seleccionId !== 'confirmar_depto') {
      await sendText(to, 'Elegí "✅ Sí, confirmar" o "↩️ Elegir otro".');
      return;
    }

    const departamento = sesion.contexto.departamento as string;
    await sendLocationRequest(
      to,
      `📍 Última cosa: contanos la dirección de entrega.\n\n` +
        `Tocá el botón de abajo para compartir tu *ubicación actual* (GPS), o si preferís, ` +
        `escribila así:\nEj: _Av. San Martín 1234, Barrio Centro, ${departamento}_`,
    );
    await setSesion({ ...sesion, paso: 'ubicacion', contexto: { departamento } });
    return;
  }

  // Paso 3: recibió la ubicación (GPS de WhatsApp o dirección escrita) -> antes
  // de guardarla, se la mostramos de vuelta y pedimos que la confirme (evita
  // guardar un pin mal tirado o una dirección mal tipeada sin que nadie lo note).
  if (sesion.paso === 'ubicacion') {
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
      await sendText(
        to,
        '📍 Necesito la dirección de entrega para poder cotizar: tocá el botón de "Enviar ubicación" ' +
          'o escribila en un mensaje (ej: _Av. San Martín 1234, Barrio Centro_).',
      );
      return;
    }

    const resumenUbicacion =
      destinoLat != null && destinoLng != null
        ? `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`
        : (destinoDireccion as string);

    await sendButtons(
      to,
      `📍 Confirmá la dirección de entrega:\n\n${resumenUbicacion}\n\n¿Es correcta?`,
      [
        { id: 'ubicacion_si', title: '✅ Sí, es correcta' },
        { id: 'ubicacion_no', title: '↩️ Volver a enviar' },
      ],
    );
    await setSesion({
      ...sesion,
      paso: 'confirmar_ubicacion',
      contexto: { ...sesion.contexto, destinoLat, destinoLng, destinoDireccion },
    });
    return;
  }

  // Paso 4: confirmó (o no) la ubicación -> recién ahí se cotiza y se cierra.
  if (sesion.paso === 'confirmar_ubicacion') {
    const departamento = sesion.contexto.departamento as string;

    if (m.seleccionId === 'ubicacion_no') {
      await sendLocationRequest(
        to,
        '📍 Dale, mandámela de nuevo: tocá "Enviar ubicación" o escribí la dirección.',
      );
      await setSesion({ ...sesion, paso: 'ubicacion', contexto: { departamento } });
      return;
    }
    if (m.seleccionId !== 'ubicacion_si') {
      await sendText(to, 'Elegí "✅ Sí, es correcta" o "↩️ Volver a enviar".');
      return;
    }

    const destinoLat = sesion.contexto.destinoLat as number | null;
    const destinoLng = sesion.contexto.destinoLng as number | null;
    const destinoDireccion = sesion.contexto.destinoDireccion as string | null;

    const tarifa = await query<{ precio: string; moneda: string }>(
      'SELECT precio, moneda FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
      [departamento],
    );
    if (tarifa.length === 0) {
      await sendText(to, '🙁 Esa tarifa ya no está disponible. Escribí *Cotizar* para reintentar.');
      await clearSesion(to);
      return;
    }

    const { precio, moneda } = tarifa[0];

    // Registrar el pedido en estado "cotizado" (traza para el panel), con la ubicación de entrega
    // y el nombre que el cliente tiene puesto en su WhatsApp (lo manda Meta solo, no hace falta pedirlo).
    await query(
      `INSERT INTO pedidos (cliente_telefono, cliente_nombre, zona, precio, estado, destino_lat, destino_lng, destino_direccion)
       VALUES ($1,$2,$3,$4,'cotizado',$5,$6,$7)`,
      [to, m.nombrePerfil ?? null, departamento, precio, destinoLat, destinoLng, destinoDireccion],
    );
    // Alta/actualización en el padrón de clientes (ver clientes.service.ts) —
    // así la pantalla Clientes del panel refleja a todo el que cotizó, no
    // solo a quien pidió cuenta corriente.
    obtenerOCrearCliente(to, m.nombrePerfil).catch((e) => console.error('Error dando de alta al cliente:', e));

    await sendText(
      to,
      `📦 *Cotización — ${departamento}*\n` +
        `Precio del flete: *${moneda} ${Number(precio).toLocaleString('es-AR')}*\n` +
        `Entrega en: ${destinoDireccion ?? `📍 ubicación compartida (${destinoLat}, ${destinoLng})`}\n\n` +
        `Para reservar, hacé el pago con estos datos:\n\n` +
        `${datosBancarios()}\n\n` +
        `Y enviános el comprobante por este chat 📎\n` +
        `(escribí *Ya pagué* o adjuntá directamente la foto/PDF).\n\n` +
        `_Escribí *menú* para volver al inicio en cualquier momento._`,
    );
    await clearSesion(to);
    return;
  }
}
