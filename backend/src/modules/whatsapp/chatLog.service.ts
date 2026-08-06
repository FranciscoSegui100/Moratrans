import { query } from '../../config/db';
import { emitMensajeChat } from '../../config/socket';

export type OrigenMensaje = 'cliente' | 'bot' | 'operador';

/**
 * Guarda un mensaje en el hilo de conversación (lo muestra el panel al tomar
 * una charla con un cliente) y lo empuja en vivo por socket a los operadores
 * conectados.
 */
export async function logMensaje(
  telefono: string,
  origen: OrigenMensaje,
  texto: string,
  usuarioId?: string,
): Promise<void> {
  const [row] = await query(
    `INSERT INTO mensajes_chat (telefono, origen, texto, usuario_id)
     VALUES ($1,$2,$3,$4) RETURNING id, telefono, origen, texto, creado_en`,
    [telefono, origen, texto, usuarioId ?? null],
  );
  if (row) emitMensajeChat(row);
}
