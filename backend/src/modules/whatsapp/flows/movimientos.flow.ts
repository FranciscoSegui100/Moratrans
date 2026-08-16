import { query } from '../../../config/db';
import { sendText, motivoErrorWa } from '../graphApi';
import { enviarExcelClientePorWhatsApp } from '../../reportes/reportes.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Detalle de movimientos: solo para clientes con cuenta corriente aprobada
 * (mismo criterio que "Pedir entrega", ver pedirEntrega.flow.ts) — es una
 * acción de un solo paso, no necesita sesión/flujo propio: genera el mismo
 * Excel que ya arma el botón del panel (ver clientes.routes.ts) y se lo
 * manda directo por WhatsApp.
 */
export async function handleDetalleMovimientos(m: MensajeEntrante, _sesion: Sesion): Promise<void> {
  const to = m.from;

  const [cliente] = await query<{ cuenta_corriente_estado: string }>(
    'SELECT cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [to],
  );
  if (cliente?.cuenta_corriente_estado !== 'aprobada') {
    await sendText(
      to,
      '📊 El detalle de movimientos es para clientes con *cuenta corriente aprobada*.\n\n' +
        'Escribí *asesor* si creés que ya deberías tener cuenta corriente.',
    );
    return;
  }

  try {
    await enviarExcelClientePorWhatsApp(to);
  } catch (e) {
    console.error('Error enviando detalle de movimientos por WhatsApp:', motivoErrorWa(e));
    await sendText(to, '⚠️ No pudimos generar tu detalle de movimientos ahora mismo. Probá de nuevo en un rato.');
  }
}
