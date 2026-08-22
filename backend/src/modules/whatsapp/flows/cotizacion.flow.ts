import { query } from '../../../config/db';
import { sendText, sendList, sendButtons, sendLocationRequest } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { datosBancarios } from './pago.flow';
import { obtenerOCrearCliente } from '../../../services/clientes.service';
import {
  estaDentroDeDepartamento,
  detectarDepartamento,
  departamentoMencionadoDistinto,
} from '../../../services/geoDepartamento.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Flujo de cotización (menú cerrado):
 *   inicio -> elegir_departamento -> ubicacion -> [confirmar_departamento_detectado, si el GPS
 *   no matchea el departamento elegido] -> confirmar_ubicacion -> [precio]
 * (elegir de una lista interactiva ya es una elección explícita: no hace
 * falta un paso extra de "¿confirmás?" después, a diferencia de la ubicación
 * -que sí puede venir de texto libre mal tipeado o un GPS mal tirado-).
 * Las tarifas se consultan SIEMPRE desde tarifas_departamento.
 */

/**
 * Arma el mensaje de "confirmá la dirección" y guarda el paso final antes de
 * cotizar. Se llama tanto desde el flujo normal como después de resolver un
 * departamento que no coincidía con la ubicación (ver geoDepartamento.service.ts).
 */
async function avanzarAConfirmarUbicacion(
  to: string,
  sesion: Sesion,
  departamento: string,
  destinoLat: number | null,
  destinoLng: number | null,
  destinoDireccion: string | null,
  avisoExtra?: string,
): Promise<void> {
  const resumenUbicacion =
    destinoLat != null && destinoLng != null
      ? `${destinoDireccion ? destinoDireccion + '\n' : ''}https://www.google.com/maps?q=${destinoLat},${destinoLng}`
      : (destinoDireccion as string);

  await sendButtons(
    to,
    `${avisoExtra ? avisoExtra + '\n\n' : ''}📍 Confirmá la dirección de entrega:\n\n${resumenUbicacion}\n\n¿Es correcta?`,
    [
      { id: 'ubicacion_si', title: '✅ Sí, es correcta' },
      { id: 'ubicacion_no', title: '↩️ Volver a enviar' },
    ],
  );
  await setSesion({
    ...sesion,
    paso: 'confirmar_ubicacion',
    contexto: { departamento, destinoLat, destinoLng, destinoDireccion },
  });
}

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

  // Paso 1: recibió la selección del departamento (elegir de la lista ya es
  // una confirmación explícita) -> pedimos directo la ubicación de entrega.
  if (sesion.paso === 'elegir_departamento') {
    if (!m.seleccionId?.startsWith('depto:')) {
      await sendText(to, 'Por favor, elegí una opción de la lista.\n\n_Escribí *menú* para volver al inicio._');
      return;
    }
    const departamento = m.seleccionId.replace('depto:', '');
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
    const departamento = sesion.contexto.departamento as string;
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

    // Con GPS: comparamos contra el polígono del departamento elegido (ver
    // geoDepartamento.service.ts). Sin este chequeo, nada impedía cotizar
    // para un departamento y compartir la ubicación de otro -> precio mal
    // calculado, y después la ruta/el aviso al chofer también mal armados.
    if (destinoLat != null && destinoLng != null) {
      const dentro = await estaDentroDeDepartamento(destinoLat, destinoLng, departamento);
      if (dentro === false) {
        const detectado = await detectarDepartamento(destinoLat, destinoLng);
        await setSesion({
          ...sesion,
          paso: 'confirmar_departamento_detectado',
          contexto: { departamento, departamentoDetectado: detectado, destinoLat, destinoLng, destinoDireccion },
        });
        if (detectado) {
          await sendButtons(
            to,
            `📍 Notamos algo raro: cotizaste para *${departamento}*, pero tu ubicación parece estar en *${detectado}*.\n\n¿Cuál es el correcto?`,
            [
              { id: 'depto_mantener', title: departamento.slice(0, 20) },
              { id: 'depto_cambiar', title: detectado.slice(0, 20) },
            ],
          );
        } else {
          await sendButtons(
            to,
            `📍 Tu ubicación no parece estar dentro de *${departamento}*, que fue lo que cotizaste.\n\n` +
              `¿Confirmamos igual con esa dirección, o preferís volver a elegir el departamento?`,
            [
              { id: 'depto_confirmar_igual', title: '✅ Confirmar igual' },
              { id: 'depto_volver', title: '↩️ Elegir depto' },
            ],
          );
        }
        return;
      }
    } else if (destinoDireccion) {
      // Sin GPS no hay coordenadas para comparar contra el polígono — lo
      // único que se puede chequear gratis es si el cliente escribió el
      // nombre de OTRO departamento en la dirección. Es solo un aviso, no
      // bloquea (puede ser una calle con nombre parecido, un falso positivo).
      const otro = await departamentoMencionadoDistinto(destinoDireccion, departamento);
      if (otro) {
        await avanzarAConfirmarUbicacion(
          to,
          sesion,
          departamento,
          destinoLat,
          destinoLng,
          destinoDireccion,
          `⚠️ Notamos que escribiste *${otro}* en la dirección, pero cotizaste para *${departamento}* — revisá antes de confirmar.`,
        );
        return;
      }
    }

    await avanzarAConfirmarUbicacion(to, sesion, departamento, destinoLat, destinoLng, destinoDireccion);
    return;
  }

  // Paso 3b: el GPS no caía dentro del departamento cotizado -> el cliente
  // decide si el que había elegido es el correcto, o si nos quedamos con el
  // que sí matchea la ubicación real (ver geoDepartamento.service.ts).
  if (sesion.paso === 'confirmar_departamento_detectado') {
    const { departamento, departamentoDetectado, destinoLat, destinoLng, destinoDireccion } = sesion.contexto as {
      departamento: string;
      departamentoDetectado: string | null;
      destinoLat: number | null;
      destinoLng: number | null;
      destinoDireccion: string | null;
    };

    if (m.seleccionId === 'depto_volver') {
      return handleCotizacion(m, { ...sesion, paso: 'inicio', contexto: {} });
    }
    if (m.seleccionId === 'depto_mantener' || m.seleccionId === 'depto_confirmar_igual') {
      return avanzarAConfirmarUbicacion(to, sesion, departamento, destinoLat, destinoLng, destinoDireccion);
    }
    if (m.seleccionId === 'depto_cambiar' && departamentoDetectado) {
      return avanzarAConfirmarUbicacion(to, sesion, departamentoDetectado, destinoLat, destinoLng, destinoDireccion);
    }
    await sendText(to, 'Elegí una de las opciones de arriba.\n\n_Escribí *menú* para volver al inicio._');
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
      await sendText(to, 'Elegí "✅ Sí, es correcta" o "↩️ Volver a enviar".\n\n_Escribí *menú* para volver al inicio._');
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
