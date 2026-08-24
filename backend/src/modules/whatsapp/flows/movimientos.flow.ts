import { query } from '../../../config/db';
import { sendText, sendButtons, motivoErrorWa } from '../graphApi';
import { enviarResumenCuentaCorrientePorWhatsApp } from '../../reportes/reportes.service';
import { ID_ASESOR_DIRECTO } from '../estados';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * "📊 Resumen de cuenta": solo para clientes con cuenta corriente aprobada
 * (mismo criterio que "Pedir entrega", ver pedirEntrega.flow.ts) — es una
 * acción de un solo paso, no necesita sesión/flujo propio: genera y manda un
 * PDF con los pedidos/entregas pendientes, zona, precio y total (ver
 * reportes.service.ts::enviarResumenCuentaCorrientePorWhatsApp). Si lo pide
 * un cliente común, se le explica y se le ofrece un asesor — regla explícita
 * del dueño (ver estados.ts::ID_ASESOR_DIRECTO, mismo botón que usa el
 * mecanismo de reintentos para escalar directo).
 */
export async function handleDetalleMovimientos(m: MensajeEntrante, _sesion: Sesion): Promise<void> {
  const to = m.from;

  const [cliente] = await query<{ nombre: string; cuenta_corriente_estado: string }>(
    'SELECT nombre, cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [to],
  );
  if (cliente?.cuenta_corriente_estado !== 'aprobada') {
    await sendButtons(to, '📊 El resumen de cuenta es para clientes con *cuenta corriente aprobada*. Si creés que ya deberías tenerla:', [
      { id: ID_ASESOR_DIRECTO, title: '🙋 Hablar con asesor' },
    ]);
    return;
  }

  try {
    await enviarResumenCuentaCorrientePorWhatsApp(to, cliente.nombre);
  } catch (e) {
    console.error('Error enviando resumen de cuenta por WhatsApp:', motivoErrorWa(e));
    await sendText(to, '⚠️ No pudimos generar tu resumen de cuenta ahora mismo. Probá de nuevo en un rato.');
  }
}
