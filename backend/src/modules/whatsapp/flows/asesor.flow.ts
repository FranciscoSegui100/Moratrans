import { query } from '../../../config/db';
import { sendText } from '../graphApi';
import { setSesion } from '../session.store';
import { emitAlerta } from '../../../config/socket';
import { INTENTOS_PARA_ESCALAR_ASESOR } from '../../../config/bot.config';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Genera la alerta para el panel, marca la conversación como tomada por un
 * humano (el bot se calla hasta que el cliente escriba "menú" o el operador
 * la resuelva) y le avisa al cliente. Compartido por dos caminos:
 *  - handleAsesor, tras INTENTOS_PARA_ESCALAR_ASESOR pedidos espontáneos de "asesor".
 *  - estados.ts::manejarRespuestaInvalida, cuando el bot mismo ofrece un
 *    asesor tras no entender la respuesta dos veces seguidas (ahí se escala
 *    directo al primer toque, sin volver a contar desde cero).
 */
export async function escalarAAsesor(to: string, sesion: Sesion, motivo: string): Promise<void> {
  const [alerta] = await query(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     VALUES ('solicita_asesor', $1, $2)
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
    [to, motivo],
  );
  if (alerta) emitAlerta({ ...alerta, cliente_telefono: to });

  await setSesion({ ...sesion, contexto: { ...sesion.contexto, asesorCount: 0, modoHumano: true } });
  const textoAviso =
    '🙋 ¡Ya avisamos a un asesor! En breve te va a contactar por acá mismo.\n\n' +
    '_Tenés una ventana de 24hs para seguir esta conversación: si pasa ese tiempo sin que escribas, ' +
    'WhatsApp la cierra y vas a tener que volver a escribirnos para retomarla._';
  await sendText(to, textoAviso);
}

/**
 * Cuenta cuántas veces el cliente pidió hablar con un asesor (persistido en
 * sesiones_chat.contexto, sin tocar el flujo/paso en el que esté) y, al
 * llegar al límite, escala vía escalarAAsesor.
 */
export async function handleAsesor(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;
  const intentos = (sesion.contexto?.asesorCount ?? 0) + 1;

  if (intentos < INTENTOS_PARA_ESCALAR_ASESOR) {
    await setSesion({ ...sesion, contexto: { ...sesion.contexto, asesorCount: intentos } });
    await sendText(
      to,
      '🙋 Puedo ayudarte yo mismo: escribí *Cotizar* o *Ya pagué* para enviar tu comprobante.\n' +
        'Si preferís, seguí escribiendo *asesor* y en breve te comunicamos con una persona del equipo.',
    );
    return;
  }

  await escalarAAsesor(to, sesion, `${to} pidió hablar con un asesor (${intentos} veces)`);
}
