import { query } from '../../../config/db';
import { sendText } from '../graphApi';
import { setSesion } from '../session.store';
import { emitAlerta } from '../../../config/socket';
import { logMensaje } from '../chatLog.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

// Cantidad de veces que el cliente tiene que pedir un asesor antes de escalar.
const INTENTOS_PARA_ESCALAR = 5;

/**
 * Cuenta cuántas veces el cliente pidió hablar con un asesor (persistido en
 * sesiones_chat.contexto, sin tocar el flujo/paso en el que esté) y, al
 * llegar al límite, genera una alerta para el panel y avisa al cliente.
 */
export async function handleAsesor(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const intentos = (sesion.contexto?.asesorCount ?? 0) + 1;

  if (intentos < INTENTOS_PARA_ESCALAR) {
    await setSesion({ ...sesion, contexto: { ...sesion.contexto, asesorCount: intentos } });
    await sendText(
      to,
      '🙋 Puedo ayudarte yo mismo: escribí *Cotizar* o *Ya pagué* para enviar tu comprobante.\n' +
        'Si preferís, seguí escribiendo *asesor* y en breve te comunicamos con una persona del equipo.',
    );
    return;
  }

  // Llegó al límite: escala a un asesor humano y notifica al panel en tiempo real.
  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('solicita_asesor', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [to, `${to} pidió hablar con un asesor (${intentos} veces)`],
  );
  if (alerta) emitAlerta({ ...alerta, cliente_telefono: to });

  // Resetea el contador y marca la conversación como tomada por un humano:
  // el bot deja de responder automáticamente hasta que el operador la resuelva
  // desde el panel (o el cliente escriba "menú").
  await setSesion({ ...sesion, contexto: { ...sesion.contexto, asesorCount: 0, modoHumano: true } });
  const textoAviso = '🙋 ¡Ya avisamos a un asesor! En breve te va a contactar por acá mismo.';
  await sendText(to, textoAviso);
  await logMensaje(to, 'bot', textoAviso).catch((e) => console.error('Error logueando mensaje:', e));
}
