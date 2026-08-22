import { query } from '../../../config/db';
import { sendText, sendButtons, motivoErrorWa } from '../graphApi';
import { enviarExcelClientePorWhatsApp } from '../../reportes/reportes.service';
import { ID_ASESOR_DIRECTO } from '../estados';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Detalle de movimientos ("resumen de cuenta" en el menú): solo para
 * clientes con cuenta corriente aprobada (mismo criterio que "Pedir
 * entrega", ver pedirEntrega.flow.ts) — es una acción de un solo paso, no
 * necesita sesión/flujo propio: genera el mismo Excel que ya arma el botón
 * del panel (ver clientes.routes.ts) y se lo manda directo por WhatsApp.
 * Si lo pide un cliente común, se le explica y se le ofrece un asesor —
 * regla explícita del dueño (ver estados.ts::ID_ASESOR_DIRECTO, mismo botón
 * que usa el mecanismo de reintentos para escalar directo).
 */
export async function handleDetalleMovimientos(m: MensajeEntrante, _sesion: Sesion): Promise<void> {
  const to = m.from;

  const [cliente] = await query<{ cuenta_corriente_estado: string }>(
    'SELECT cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [to],
  );
  if (cliente?.cuenta_corriente_estado !== 'aprobada') {
    await sendButtons(to, '📊 El resumen de cuenta es para clientes con *cuenta corriente aprobada*. Si creés que ya deberías tenerla:', [
      { id: ID_ASESOR_DIRECTO, title: '🙋 Hablar con asesor' },
    ]);
    return;
  }

  try {
    await enviarExcelClientePorWhatsApp(to);
  } catch (e) {
    console.error('Error enviando detalle de movimientos por WhatsApp:', motivoErrorWa(e));
    await sendText(to, '⚠️ No pudimos generar tu detalle de movimientos ahora mismo. Probá de nuevo en un rato.');
  }
}
