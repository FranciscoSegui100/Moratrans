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

/**
 * Cuelga un archivo recién guardado en Storage del mensaje del cliente que
 * lo trajo (el último "📎 Imagen"/"📎 Documento" de ese teléfono: el webhook
 * lo loguea justo antes de enrutar), para que se pueda abrir desde
 * Conversaciones. Nunca corta el flujo: es solo para la vista del panel.
 */
export async function adjuntarAUltimoMensaje(telefono: string, rutaCifrada: string): Promise<void> {
  await query(
    `UPDATE mensajes_chat SET adjunto_ruta = $2
      WHERE id = (
        SELECT id FROM mensajes_chat
         WHERE telefono = $1 AND origen = 'cliente' AND adjunto_ruta IS NULL
           AND texto IN ('📎 Imagen', '📎 Documento')
         ORDER BY creado_en DESC LIMIT 1
      )`,
    [telefono, rutaCifrada],
  ).catch((e) => console.error('Error adjuntando archivo al mensaje:', e));
}
