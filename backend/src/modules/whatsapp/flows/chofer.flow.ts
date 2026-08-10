import { query } from '../../../config/db';
import { sendText, sendList, sendButtons } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { emitAlerta, emitRecursoActualizado } from '../../../config/socket';
import { blindIndex } from '../../../services/crypto.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

// Únicos estados que un chofer puede aplicar.
const ESTADOS_CHOFER = ['en_camino', 'entregado', 'retirado'] as const;

// Título del botón: WhatsApp corta a 20 caracteres, por eso van cortos.
const LABEL_ESTADO: Record<(typeof ESTADOS_CHOFER)[number], string> = {
  en_camino: '🚛 Voy en camino',
  entregado: '📦 Ya entregué',
  retirado: '📥 Ya retiré',
};

export async function handleChofer(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  // 1) Identificación por teléfono
  const chofer = await query<{ id: string; nombre: string }>(
    'SELECT id, nombre FROM choferes WHERE telefono = $1 AND activo = TRUE',
    [to],
  );

  // 1a) No reconocido: pedir DNI para validar
  if (chofer.length === 0) {
    if (sesion.paso === 'esperando_dni' && m.tipo === 'text') {
      const dni = (m.texto ?? '').replace(/\D/g, '');
      const match = await query<{ id: string; nombre: string; telefono: string | null }>(
        'SELECT id, nombre, telefono FROM choferes WHERE dni_hash = $1 AND activo = TRUE',
        [blindIndex(dni)],
      );
      if (match.length > 0) {
        const chofer = match[0];
        if (!chofer.telefono) {
          // Primer vínculo: no hay número previo que pisar, se aplica directo.
          await query('UPDATE choferes SET telefono = $1 WHERE id = $2', [to, chofer.id]);
          await clearSesion(to);
          await sendText(to, `✅ ¡Buenísimo, ${chofer.nombre}! Ya te vinculamos el número. 🚚`);
          return menuChofer(to);
        }
        // Ya tiene otro número vinculado: el DNI solo no alcanza para pisarlo
        // (evita que alguien con el DNI de un chofer le robe el número). Requiere
        // que un operador lo revise y lo cambie a mano desde el panel.
        const [alerta] = await query(
          `INSERT INTO alertas (tipo, referencia_id, mensaje)
           VALUES ('chofer_cambio_telefono', $1, $2)
           ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
           RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
          [
            chofer.id,
            `${chofer.nombre} ya tiene el número ${chofer.telefono} vinculado, pero alguien se validó con su DNI desde ${to}. Si es realmente ${chofer.nombre}, cambiá el teléfono desde la ficha del chofer.`,
          ],
        );
        if (alerta) emitAlerta(alerta);
        await clearSesion(to);
        await sendText(
          to,
          `🔒 Ese DNI ya tiene otro número de WhatsApp vinculado. Avisamos a un operador para que confirme el cambio antes de aplicarlo.`,
        );
        return;
      }
      // No coincide: derivar a operador
      const [alerta] = await query(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('chofer_no_reconocido', $1, $2) RETURNING id, tipo, referencia_id, mensaje, creado_en`,
        [to, `Chofer no reconocido (${to}) intentó validarse con DNI ${dni}`],
      );
      if (alerta) emitAlerta(alerta);
      await clearSesion(to);
      await sendText(
        to,
        '🙁 Ese DNI no nos cierra. Ya avisamos a un operador para que te contacte y te dé una mano.',
      );
      return;
    }
    // Primer contacto: pedir DNI
    await setSesion({ telefono: to, flujo: 'chofer', paso: 'esperando_dni', contexto: {} });
    await sendText(to, '🚚 ¡Hola! No tengo este número registrado. Pasame tu *DNI* para validarte como chofer.');
    return;
  }

  // 2) Chofer reconocido: manejar cambio de estado (botones) y elección de contenedor (lista).
  if (m.tipo === 'interactive_button' && m.seleccionId?.startsWith('estado:')) {
    return elegirContenedor(to, chofer[0].id, m.seleccionId.replace('estado:', ''), sesion);
  }
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('cont:')) {
    return aplicarEstado(to, chofer[0].id, chofer[0].nombre, m.seleccionId.replace('cont:', ''), sesion);
  }

  return menuChofer(to, chofer[0].nombre);
}

/**
 * Menú principal del chofer: 3 botones pegados al mensaje (un solo toque),
 * en vez de una lista desplegable — más rápido para alguien manejando.
 * Se manda después de cada acción para que nunca tenga que escribir "menú".
 */
export async function menuChofer(to: string, nombre?: string): Promise<void> {
  await sendButtons(
    to,
    nombre ? `🚚 ¡Hola, ${nombre}! ¿Qué querés registrar?` : '🚚 Panel del chofer. ¿Qué querés registrar?',
    ESTADOS_CHOFER.map((e) => ({ id: `estado:${e}`, title: LABEL_ESTADO[e] })),
  );
}

/** Tras elegir estado, listar contenedores candidatos. */
async function elegirContenedor(to: string, choferId: string, estado: string, sesion: Sesion): Promise<void> {
  if (!ESTADOS_CHOFER.includes(estado as any)) {
    await sendText(to, 'Esa acción no está disponible para choferes.');
    return menuChofer(to);
  }
  // Contenedores en un estado desde el que la transición es válida.
  const origen =
    estado === 'en_camino' ? 'reservado' : estado === 'entregado' ? 'en_camino' : 'entregado';
  const conts = await query<{ numero: string }>(
    'SELECT numero FROM contenedores WHERE estado = $1 ORDER BY actualizado_en LIMIT 10',
    [origen],
  );
  if (conts.length === 0) {
    await sendText(to, `🙁 No tengo contenedores en estado "${origen}" para pasar a "${estado.replace('_', ' ')}".`);
    return menuChofer(to);
  }
  await setSesion({ telefono: to, flujo: 'chofer', paso: 'elegir_contenedor', contexto: { estado } });
  await sendList(
    to,
    LABEL_ESTADO[estado as keyof typeof LABEL_ESTADO],
    '¿Cuál contenedor?',
    'Ver contenedores',
    conts.map((c) => ({ id: `cont:${c.numero}`, title: c.numero })),
  );
}

/** Aplica el cambio de estado (el trigger de la DB valida la transición y audita). */
async function aplicarEstado(
  to: string,
  choferId: string,
  choferNombre: string,
  numero: string,
  sesion: Sesion,
): Promise<void> {
  const estado = sesion.contexto.estado as string;
  if (!ESTADOS_CHOFER.includes(estado as any)) {
    await sendText(to, 'Esa acción no está disponible.');
    await clearSesion(to);
    return menuChofer(to, choferNombre);
  }

  // "Retirado" no se aplica al toque: queda pendiente hasta que un operador
  // confirme desde el panel que el contenedor llegó físicamente a la empresa.
  if (estado === 'retirado') {
    try {
      await query(
        `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, estado, notas)
         VALUES ('retiro', CURRENT_DATE, $1, $2, 'en_curso', 'Retirado del cliente por WhatsApp, pendiente de confirmar llegada a la empresa')`,
        [choferId, numero],
      );
      const [alerta] = await query(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('confirmar_retiro', $1, $2)
         ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
         RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
        [numero, `${choferNombre} retiró el contenedor ${numero} del cliente. Confirmá cuando llegue a la empresa.`],
      );
      if (alerta) emitAlerta(alerta);
      await clearSesion(to);
      await sendText(
        to,
        `📥 ¡Anotado! En cuanto el contenedor *${numero}* llegue a la empresa, un operador lo confirma y te avisamos por acá. ¡Gracias por tu trabajo! 🙌`,
      );
    } catch (err: any) {
      await sendText(to, `⚠️ No pudimos registrar el retiro de ${numero}. Probá de nuevo.`);
      console.error('Error registrando retiro pendiente:', err.message);
    }
    return menuChofer(to, choferNombre);
  }

  try {
    // El trigger fn_validar_transicion_contenedor rechaza transiciones ilegales.
    await query(
      'UPDATE contenedores SET estado = $1, actualizado_por = $2 WHERE numero = $3',
      [estado, `chofer:${choferId}`, numero],
    );
    // Historial explícito con el chofer (el trigger también audita, pero sin chofer_id).
    await query(
      'INSERT INTO historial_contenedores (numero_contenedor, estado, chofer_id, nota) VALUES ($1,$2,$3,$4)',
      [numero, estado, choferId, 'registrado por chofer vía WhatsApp'],
    );
    // Este cambio viene del webhook de WhatsApp, no de la API del panel, así
    // que no pasa por el middleware que avisa solo (broadcastCambios) — sin
    // esto, la pestaña Contenedores quedaba desactualizada hasta hacer F5.
    emitRecursoActualizado('contenedores');
    await clearSesion(to);
    await sendText(to, `✅ ¡Listo! Contenedor *${numero}* marcado como *${estado.replace('_', ' ')}*. 💪`);
  } catch (err: any) {
    // Error de transición inválida u otro
    await sendText(
      to,
      `⚠️ No pude aplicar el cambio en ${numero}. Puede que el contenedor no esté en el estado correcto.`,
    );
    console.error('Error aplicarEstado:', err.message);
  }
  return menuChofer(to, choferNombre);
}
