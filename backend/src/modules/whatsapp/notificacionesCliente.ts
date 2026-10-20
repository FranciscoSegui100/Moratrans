import { query } from '../../config/db';
import { sendText, sendButtons, motivoErrorWa } from './graphApi';
import { formatearTelefonoLegible } from '../../services/telefono.service';
import { formatearFechaLarga } from '../../services/diasHabiles.service';

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
 * Avisa al cliente que su pedido quedó confirmado al armar/confirmar la
 * ruta — a diferencia de `notificarClienteChoferEnCamino`, esto NO significa
 * que el chofer ya salió: una ruta se puede confirmar con uno o varios días
 * de anticipación, así que decirle "ya está en camino" en ese momento es
 * directamente falso. El aviso de "en camino" de verdad llega después, recién
 * cuando el chofer termina la parada anterior (avisarSiguienteParadaRuta) o
 * es la primera de su día. Tampoco expone chofer/patente/contenedor acá: en
 * esta instancia todavía puede cambiar (reasignación, reordenamiento), y no
 * es información que el cliente necesite antes de que el chofer esté yendo.
 */
export async function notificarClientePedidoConfirmado(params: {
  clienteTelefono: string | null;
  tipo: 'entrega' | 'retiro';
  destinoDireccion: string | null;
  fecha: string;
}): Promise<void> {
  const { clienteTelefono, tipo, destinoDireccion, fecha } = params;
  if (!clienteTelefono) return;

  const accion = tipo === 'entrega' ? 'la entrega' : 'el retiro';
  const direccion = destinoDireccion ? `📍 *Destino:* ${destinoDireccion}\n\n` : '';

  const mensaje =
    `¡Hola! ✅ Tu pedido quedó confirmado.\n\n` +
    direccion +
    `El chofer se va a poner en contacto para coordinar ${accion} el día *${formatearFechaLarga(fecha)}*.\n\n` +
    `Si tenés alguna duda podés escribirnos por acá. ¡Muchas gracias!`;

  try {
    await sendText(clienteTelefono, mensaje);
  } catch (err: any) {
    console.error(`[notificacionesCliente] Error al notificar pedido confirmado a ${clienteTelefono}:`, motivoErrorWa(err));
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
