import cron from 'node-cron';
import { query } from '../config/db';
import { sendText } from '../modules/whatsapp/graphApi';
import { clearSesion } from '../modules/whatsapp/session.store';

// Ver migración 0023_aviso_inactividad_sesion.sql. No aplica al flujo
// 'chofer' (uso interno, no es atención al cliente) ni a conversaciones ya
// tomadas por un operador humano (contexto.modoHumano).
const AVISO_TRAS_MIN = 5;
const CIERRE_TRAS_MIN = 5; // minutos desde el aviso, no desde la última actividad

const MENSAJE_AVISO = 'En caso de no recibir respuesta, cerraremos el chat en los próximos minutos 🕒.';
const MENSAJE_CIERRE =
  'Pasó el tiempo y tengo que cerrar nuestra conversación para seguir ayudando a más personas. ' +
  'Cuando lo necesites, no dudes en escribirme nuevamente. 😊';

/** Manda el aviso de "se va a cerrar el chat" a sesiones inactivas hace 5 min. */
async function avisarInactivos(): Promise<void> {
  const pendientes = await query<{ telefono: string }>(
    `SELECT telefono FROM sesiones_chat
      WHERE flujo IS NOT NULL
        AND flujo <> 'chofer'
        AND (contexto->>'modoHumano') IS DISTINCT FROM 'true'
        AND avisado_en IS NULL
        AND actualizado_en < now() - ($1 || ' minutes')::interval`,
    [String(AVISO_TRAS_MIN)],
  );
  for (const { telefono } of pendientes) {
    await sendText(telefono, MENSAJE_AVISO).catch((e) => console.error('[cron inactividad] error avisando:', e));
    await query('UPDATE sesiones_chat SET avisado_en = now() WHERE telefono = $1', [telefono]);
  }
}

/** Cierra (y avisa) las sesiones que ya fueron avisadas hace 5 min y siguieron sin responder. */
async function cerrarInactivos(): Promise<void> {
  const pendientes = await query<{ telefono: string }>(
    `SELECT telefono FROM sesiones_chat
      WHERE avisado_en IS NOT NULL
        AND avisado_en < now() - ($1 || ' minutes')::interval`,
    [String(CIERRE_TRAS_MIN)],
  );
  for (const { telefono } of pendientes) {
    await sendText(telefono, MENSAJE_CIERRE).catch((e) => console.error('[cron inactividad] error cerrando:', e));
    await clearSesion(telefono);
  }
}

/** Programa el cron cada 1 minuto (necesita más granularidad que el de alertas por la ventana de 5 min). */
export function iniciarCronInactividadChat(): void {
  cron.schedule('* * * * *', () => {
    avisarInactivos().catch((e) => console.error('[cron inactividad] error:', e));
    cerrarInactivos().catch((e) => console.error('[cron inactividad] error:', e));
  });
  console.log('⏰ Cron de inactividad de chat activo (aviso 5min / cierre 5min después)');
}
