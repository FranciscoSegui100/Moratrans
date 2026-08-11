import { query } from '../../config/db';
import { emitAlerta } from '../../config/socket';

/**
 * Registra en el panel (tabla alertas) un envío de WhatsApp crítico que
 * falló, para que un operador se entere y pueda actuar (llamar al
 * cliente/chofer, reenviar a mano) en vez de que el error se pierda en
 * los logs de Railway sin que nadie lo vea.
 */
export async function notificarEnvioFallido(
  referenciaId: string,
  destinatario: string,
  contexto: string,
  motivo: string,
): Promise<void> {
  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('envio_fallido', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [referenciaId, `No se pudo enviar WhatsApp a ${destinatario} (${contexto}): ${motivo}`],
  );
  if (alerta) emitAlerta(alerta);
}
