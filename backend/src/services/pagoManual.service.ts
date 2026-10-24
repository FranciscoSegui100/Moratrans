import { encrypt, encryptBuffer } from './crypto.service';
import { subirArchivo } from './storage.service';
import { sendText, motivoErrorWa } from '../modules/whatsapp/graphApi';
import { notificarEnvioFallido } from '../modules/whatsapp/alertaEnvio';
import { datosBancarios } from '../modules/whatsapp/flows/pago.flow';

/** Mismo patrón que el resto del código: un error con `.status` que las rutas mapean a la respuesta HTTP. */
function fail(msg: string, status = 409): never {
  const err: any = new Error(msg);
  err.status = status;
  throw err;
}

/**
 * Reglas de plata para cualquier cosa que un operador carga/programa a mano
 * desde el panel (viaje manual, alargue, recambio, retiro anticipado) —
 * mismo criterio confirmado con el dueño del negocio (ver originalmente
 * clientes.routes.ts POST /:telefono/viaje-manual):
 *  - Pagado -> 'validado', nunca cargo de cuenta corriente.
 *  - No pagado + cuenta corriente (aprobada o pendiente) -> cargo directo
 *    (es_cuenta_corriente=TRUE, 'validado'), sin avisar nada — se cobra junto.
 *  - No pagado + ocasional -> 'pendiente' + se le manda la solicitud de pago
 *    por WhatsApp (ver pedirPagoPorWhatsApp).
 */
export function reglasDePago(cuentaCorrienteEstado: string | null | undefined, pagado: boolean) {
  const esCC = cuentaCorrienteEstado === 'aprobada' || cuentaCorrienteEstado === 'pendiente';
  const cargoCC = esCC && !pagado;
  const estado = cargoCC || pagado ? 'validado' : 'pendiente';
  return { esCC, cargoCC, estado };
}

/**
 * Sube y cifra un comprobante de transferencia — mismo criterio que uno que
 * llega por WhatsApp (ver pago.flow.ts).
 */
export async function subirComprobanteManual(base64: string, contentType: string | undefined, prefijo: string): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > 8 * 1024 * 1024) fail('El comprobante no puede pesar más de 8MB', 400);
  const mime = contentType || 'image/jpeg';
  const ext = mime.includes('pdf') ? 'pdf' : mime.split('/')[1] || 'jpg';
  const ruta = `comprobantes/${prefijo}_${Date.now()}.${ext}`;
  await subirArchivo(encryptBuffer(buffer), ruta, 'application/octet-stream');
  return encrypt(ruta);
}

/** Avisa por WhatsApp un pago pendiente que un operador acaba de cargar a mano (cliente ocasional, no pagado). */
export async function pedirPagoPorWhatsApp(
  telefono: string,
  monto: number,
  concepto: string,
  medioPago: 'efectivo' | 'transferencia',
  contenedorNumero?: string | null,
): Promise<void> {
  const detalleContenedor = contenedorNumero ? ` del contenedor ${contenedorNumero}` : '';
  const cuerpo =
    `📋 Tenés un pago pendiente de *$${monto.toLocaleString('es-AR')}* — ${concepto}${detalleContenedor}.\n\n` +
    (medioPago === 'transferencia'
      ? `${datosBancarios()}\n\nCuando hagas la transferencia, mandanos la foto del comprobante por acá. 📎`
      : '💵 Coordiná con nosotros el pago en efectivo cuando puedas.');
  try {
    await sendText(telefono, cuerpo);
  } catch (e) {
    const motivo = motivoErrorWa(e);
    console.error('Error mandando solicitud de pago manual:', motivo);
    notificarEnvioFallido(telefono, telefono, `solicitud de pago de ${concepto}`, motivo).catch((e2) =>
      console.error('Error registrando alerta de envío fallido:', e2),
    );
  }
}
