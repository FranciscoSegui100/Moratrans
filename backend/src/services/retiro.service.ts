import { query } from '../config/db';
import { sendText, motivoErrorWa } from '../modules/whatsapp/graphApi';
import { emitAlertaActualizada, emitRecursoActualizado } from '../config/socket';

/**
 * Cierra el ciclo de un retiro: pasa el contenedor de 'retirado' a
 * 'disponible' (vacía vence_en/cliente_id, ya no aplican al cliente
 * anterior), cierra las filas de `viajes` involucradas (el propio retiro +
 * la entrega que lo trajo, si la había) y, si había una entrega reservada a
 * futuro esperando a que este contenedor volviera, la promueve a
 * 'reservado' de una — no queda una ventana en 'disponible' donde otro
 * pedido se lo podría llevar primero.
 *
 * Lo llaman dos caminos:
 *  - El chofer solo por WhatsApp ("🗑️ Ya vacié", ver chofer.flow.ts): ya no
 *    hace falta que un operador confirme que el contenedor llegó físicamente.
 *  - El panel, como respaldo manual (POST /api/contenedores/:numero/confirmar-retiro)
 *    para casos raros donde el chofer no puede usar el bot.
 *
 * `choferIdEsperado`: si se pasa, sólo encuentra un retiro en curso de ESE
 * chofer — evita que alguien finalice por WhatsApp el retiro de otro chofer.
 */
export async function finalizarRetiro(
  numero: string,
  actualizadoPor: string,
  choferIdEsperado?: string,
): Promise<{ error: string } | { ok: true }> {
  const params: any[] = [numero];
  let filtroChofer = '';
  if (choferIdEsperado) {
    params.push(choferIdEsperado);
    filtroChofer = ` AND chofer_id = $${params.length}`;
  }
  const [viaje] = await query<{ id: string; chofer_id: string | null }>(
    `SELECT id, chofer_id FROM viajes
      WHERE contenedor_numero = $1 AND tipo = 'retiro' AND estado = 'en_curso'${filtroChofer}
      ORDER BY creado_en DESC LIMIT 1`,
    params,
  );
  if (!viaje) return { error: 'No hay un retiro pendiente de confirmación para ese contenedor' };

  try {
    // El trigger fn_validar_transicion_contenedor solo permite "entregado" ->
    // "retirado" directo; de ahí sí puede pasar a "disponible" (dos updates,
    // cada uno válido por separado para el trigger).
    await query(
      `UPDATE contenedores SET estado = 'retirado', actualizado_por = $2 WHERE numero = $1`,
      [numero, actualizadoPor],
    );
    await query(
      `UPDATE contenedores SET estado = 'disponible', vence_en = NULL, cliente_id = NULL, actualizado_por = $2 WHERE numero = $1`,
      [numero, actualizadoPor],
    );
  } catch (e: any) {
    return { error: e.message };
  }

  // El trigger fn_auditar_contenedor ya audita los dos UPDATE de arriba en
  // historial_contenedores — no duplicar el insert acá.
  await query(`UPDATE viajes SET estado = 'completado' WHERE id = $1`, [viaje.id]);
  if (viaje.chofer_id) {
    // El viaje de "entrega" (creado al validar el pago o al programarlo a
    // mano) recién se cierra acá, cuando termina el ciclo completo — si se
    // completaba antes, el chofer dejaba de tener un viaje activo vinculado
    // y el filtro de seguridad de elegirContenedor (solo contenedores de SU
    // propio viaje activo) le ocultaba el contenedor a la hora de elegir.
    await query(
      `UPDATE viajes SET estado = 'completado'
        WHERE contenedor_numero = $1 AND chofer_id = $2 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso')`,
      [numero, viaje.chofer_id],
    );
  }

  // Si había una entrega reservada a futuro para este contenedor (ver POST
  // /api/viajes: se permite reservar un contenedor ocupado para una fecha
  // posterior a su vuelta), ahora que efectivamente volvió pasa directo a
  // "reservado".
  const [futura] = await query<{ id: string; chofer_id: string | null }>(
    `SELECT id, chofer_id FROM viajes
      WHERE contenedor_numero = $1 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso')
      ORDER BY fecha LIMIT 1`,
    [numero],
  );
  if (futura) {
    await query(
      `UPDATE contenedores SET estado = 'reservado', actualizado_por = $2 WHERE numero = $1`,
      [numero, actualizadoPor],
    );
    if (futura.chofer_id) {
      const [choferFutura] = await query<{ telefono: string }>('SELECT telefono FROM choferes WHERE id = $1', [futura.chofer_id]);
      if (choferFutura?.telefono) {
        sendText(
          choferFutura.telefono,
          `📦 El contenedor *${numero}* que tenías reservado ya volvió y quedó a tu nombre. Coordinemos la entrega.`,
        ).catch((e) => console.error('Error avisando reserva futura lista:', motivoErrorWa(e)));
      }
    }
  }

  await query(
    `UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'confirmar_retiro' AND referencia_id = $1`,
    [numero],
  );
  emitAlertaActualizada({ tipo: 'confirmar_retiro', referencia_id: numero, estado: 'resuelta' });
  emitRecursoActualizado('contenedores');
  emitRecursoActualizado('viajes');

  if (viaje.chofer_id) {
    const [chofer] = await query<{ telefono: string }>('SELECT telefono FROM choferes WHERE id = $1', [viaje.chofer_id]);
    if (chofer) {
      sendText(
        chofer.telefono,
        `✅ Confirmado: el contenedor *${numero}* ya quedó registrado en la empresa. ¡Gracias por tu trabajo! 🙌`,
      ).catch((e) => console.error('Error avisando al chofer:', motivoErrorWa(e)));
    }
  }

  return { ok: true };
}
