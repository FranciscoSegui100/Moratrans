import { query } from '../../config/db';
import { sendText, sendButtons, motivoErrorWa } from './graphApi';
import { formatearTelefonoLegible } from '../../services/telefono.service';

/**
 * Notifica al cliente cuando el chofer ya está yendo a su domicilio
 * (la parada pasó a ser la próxima activa en la ruta).
 */
export async function notificarClienteChoferEnCamino(params: {
  clienteTelefono: string | null;
  tipo: 'entrega' | 'retiro';
  destinoDireccion: string | null;
  choferNombre: string | null;
  patente: string | null;
  contenedorNumero: string | null;
}): Promise<void> {
  const { clienteTelefono, tipo, destinoDireccion, choferNombre, patente, contenedorNumero } = params;
  if (!clienteTelefono) return;

  const accion = tipo === 'entrega' ? 'entregar tu contenedor' : 'retirar el contenedor';
  const direccion = destinoDireccion ? `📍 *Destino:* ${destinoDireccion}\n` : '';
  const chofer = choferNombre ? `🚚 *Chofer:* ${choferNombre}${patente ? ` (Patente: ${patente})` : ''}\n` : '';
  const cont = contenedorNumero ? `📦 *Contenedor:* ${contenedorNumero}\n` : '';

  const mensaje =
    `¡Hola! 🚛 Te avisamos que nuestro chofer ya está en camino para ${accion}.\n\n` +
    direccion +
    chofer +
    cont +
    `\nPor favor asegurate de tener el acceso despejado. Si tenés alguna duda podés escribirnos por acá. ¡Muchas gracias!`;

  try {
    await sendText(clienteTelefono, mensaje);
  } catch (err: any) {
    console.error(`[notificacionesCliente] Error al notificar chofer en camino a ${clienteTelefono}:`, motivoErrorWa(err));
  }
}

/**
 * Envía una encuesta de satisfacción y confirmación de servicio al cliente
 * una vez finalizada la entrega o el retiro.
 */
export async function notificarClienteServicioFinalizado(params: {
  clienteTelefono: string | null;
  tipo: 'entrega' | 'retiro';
  contenedorNumero: string | null;
}): Promise<void> {
  const { clienteTelefono, tipo, contenedorNumero } = params;
  if (!clienteTelefono) return;

  const titulo = tipo === 'entrega' ? '¡Tu contenedor fue entregado! 📦' : '¡Tu contenedor fue retirado con éxito! 📥';
  const detalle = contenedorNumero ? `Contenedor: *${contenedorNumero}*\n\n` : '\n\n';
  const cuerpo =
    `✨ *${titulo}*\n\n` +
    detalle +
    `¿Cómo calificarías nuestro servicio hoy? Tu opinión nos ayuda a seguir mejorando:`;

  const botones = [
    { id: 'encuesta_5', title: '⭐⭐⭐⭐⭐ Excelente' },
    { id: 'encuesta_3', title: '⭐⭐⭐ Bueno' },
    { id: 'encuesta_1', title: '⭐ A mejorar' },
  ];

  try {
    await sendButtons(clienteTelefono, cuerpo, botones);
  } catch (err: any) {
    console.error(`[notificacionesCliente] Error al enviar encuesta a ${clienteTelefono}:`, motivoErrorWa(err));
  }
}
