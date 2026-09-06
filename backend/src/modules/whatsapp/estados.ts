import { sendText, sendButtons } from './graphApi';
import { registrarIntentoInvalido } from './session.store';
import { escalarAAsesor } from './flows/asesor.flow';
import { LIMITE_INTENTOS_INVALIDOS } from '../../config/bot.config';
import type { MensajeEntrante } from './messageRouter';
import type { Sesion } from './session.store';

/** Botón que ofrece escalar directo a un asesor tras respuestas inválidas seguidas. */
export const ID_ASESOR_DIRECTO = 'estado_asesor_directo';

/**
 * Punto único para "el cliente contestó algo que no corresponde al estado
 * actual". Cada estado la llama en vez de mandar el texto de error directo:
 *  - 1era vez seguida: repite `mensaje` tal cual.
 *  - 2da vez seguida (o más, LIMITE_INTENTOS_INVALIDOS): agrega un botón para
 *    hablar con un asesor, en vez de insistir con el mismo mensaje para siempre.
 * El contador se resetea solo en la próxima transición válida (setSesion).
 */
export async function manejarRespuestaInvalida(m: MensajeEntrante, mensaje: string): Promise<void> {
  const to = m.from;
  const intentos = await registrarIntentoInvalido(to);

  if (intentos < LIMITE_INTENTOS_INVALIDOS) {
    await sendText(to, mensaje);
    return;
  }

  await sendButtons(to, `${mensaje}\n\nSi preferís, seguimos con una persona del equipo.`, [
    { id: ID_ASESOR_DIRECTO, title: '🙋 Hablar con asesor' },
  ]);
}

/**
 * ¿Este mensaje es el botón de "Hablar con asesor" que ofreció
 * manejarRespuestaInvalida? Si es así, escala directo (sin pasar por el
 * contador de 3 pedidos espontáneos de handleAsesor — acá ya quedó claro
 * que el bot no está entendiendo, no hace falta que insista más).
 */
export function esAsesorDirecto(m: MensajeEntrante): boolean {
  return m.seleccionId === ID_ASESOR_DIRECTO;
}

export async function manejarAsesorDirecto(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  await escalarAAsesor(m.from, sesion, `${m.from} no pudo completar el flujo (respuestas inválidas seguidas)`);
}
