import { query } from '../../../config/db';
import { sendText, sendButtons, sendList, motivoErrorWa } from '../graphApi';
import { clearSesion, setSesion } from '../session.store';
import { emitRecursoActualizado } from '../../../config/socket';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

interface RetiroProgramado {
  id: string;
  fecha: string;
  contenedor_numero: string | null;
}

/**
 * El cliente cancela un retiro que todavía no salió. Solo aplica a retiros
 * en 'programado' (no a uno ya 'en_curso' — ahí el chofer ya está en la
 * calle, hay que resolverlo por asesor). No toca el contenedor: sigue
 * 'entregado' en lo del cliente, solo se cancela la fila de `viajes`.
 */
export async function handleCancelarRetiro(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  if (sesion.paso === 'elegir_retiro_cancelar') {
    return manejarEleccion(m);
  }
  if (sesion.paso === 'confirmar_cancelacion') {
    return manejarConfirmacion(m, sesion);
  }

  const retiros = await retirosProgramados(to);
  if (retiros.length === 0) {
    await clearSesion(to);
    await sendText(to, '🙁 No tenés ningún retiro programado en este momento.');
    return;
  }
  if (retiros.length === 1) {
    return pedirConfirmacion(to, retiros[0]);
  }
  await setSesion({ telefono: to, flujo: 'cancelar_retiro', paso: 'elegir_retiro_cancelar', contexto: {} });
  await sendList(
    to,
    '❌ Cancelar retiro',
    'Tenés más de un retiro programado — ¿cuál querés cancelar?',
    'Ver retiros',
    retiros.map((r) => ({
      id: `cancret:${r.id}`,
      title: r.contenedor_numero ?? 'Retiro',
      description: new Date(r.fecha).toLocaleDateString('es-AR'),
    })),
  );
}

async function retirosProgramados(telefono: string): Promise<RetiroProgramado[]> {
  return query<RetiroProgramado>(
    `SELECT id, fecha, contenedor_numero
       FROM viajes
      WHERE cliente_telefono = $1 AND tipo = 'retiro' AND estado = 'programado'
      ORDER BY fecha`,
    [telefono],
  );
}

async function manejarEleccion(m: MensajeEntrante): Promise<void> {
  const to = m.from;
  if (m.tipo !== 'interactive_list' || !m.seleccionId?.startsWith('cancret:')) {
    await sendText(to, 'Por favor, elegí uno de la lista de arriba. 👆');
    return;
  }
  const id = m.seleccionId.replace('cancret:', '');
  const retiro = (await retirosProgramados(to)).find((r) => r.id === id);
  if (!retiro) {
    await clearSesion(to);
    await sendText(to, '🙁 Ese retiro ya no está disponible. Escribí *menú* para volver a empezar.');
    return;
  }
  await pedirConfirmacion(to, retiro);
}

async function pedirConfirmacion(to: string, retiro: RetiroProgramado): Promise<void> {
  await setSesion({ telefono: to, flujo: 'cancelar_retiro', paso: 'confirmar_cancelacion', contexto: { id: retiro.id } });
  await sendButtons(
    to,
    `❌ ¿Confirmás que querés cancelar el retiro${retiro.contenedor_numero ? ` del contenedor *${retiro.contenedor_numero}*` : ''} ` +
      `programado para el ${new Date(retiro.fecha).toLocaleDateString('es-AR')}?`,
    [
      { id: 'cancelar_retiro_si', title: '✅ Sí, cancelar' },
      { id: 'cancelar_retiro_no', title: '↩️ No, dejarlo' },
    ],
  );
}

async function manejarConfirmacion(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  if (m.seleccionId === 'cancelar_retiro_no') {
    await clearSesion(to);
    await sendText(to, '👍 Dejamos el retiro como estaba. Escribí *menú* si necesitás algo más.');
    return;
  }
  if (m.seleccionId !== 'cancelar_retiro_si') {
    await sendText(to, 'Elegí "✅ Sí, cancelar" o "↩️ No, dejarlo".');
    return;
  }

  const id = sesion.contexto.id as string;
  const [retiro] = await query<{ contenedor_numero: string | null; chofer_id: string | null; fecha: string }>(
    `UPDATE viajes SET estado = 'cancelado' WHERE id = $1 AND estado = 'programado'
     RETURNING contenedor_numero, chofer_id, fecha`,
    [id],
  );
  if (!retiro) {
    await clearSesion(to);
    await sendText(to, '🙁 Ese retiro ya no se puede cancelar (puede que ya esté en curso). Escribí *asesor* si necesitás ayuda.');
    return;
  }
  emitRecursoActualizado('viajes');

  if (retiro.chofer_id) {
    const [chofer] = await query<{ telefono: string | null }>('SELECT telefono FROM choferes WHERE id = $1', [retiro.chofer_id]);
    if (chofer?.telefono) {
      sendText(
        chofer.telefono,
        `❌ El cliente canceló el retiro${retiro.contenedor_numero ? ` del contenedor *${retiro.contenedor_numero}*` : ''} ` +
          `programado para el ${new Date(retiro.fecha).toLocaleDateString('es-AR')}.`,
      ).catch((e) => console.error('Error avisando cancelación al chofer:', motivoErrorWa(e)));
    }
  }

  await clearSesion(to);
  await sendText(to, '✅ Listo, cancelamos el retiro. Avisanos cuando quieras coordinar uno nuevo.');
}
