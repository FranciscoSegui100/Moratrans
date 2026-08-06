import { query } from '../../config/db';

export type OrigenMensaje = 'cliente' | 'bot' | 'operador';

/** Guarda un mensaje en el hilo de conversación (lo muestra el panel al tomar una charla con un cliente). */
export async function logMensaje(
  telefono: string,
  origen: OrigenMensaje,
  texto: string,
  usuarioId?: string,
): Promise<void> {
  await query(
    'INSERT INTO mensajes_chat (telefono, origen, texto, usuario_id) VALUES ($1,$2,$3,$4)',
    [telefono, origen, texto, usuarioId ?? null],
  );
}
