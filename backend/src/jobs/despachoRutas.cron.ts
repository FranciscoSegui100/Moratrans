import cron from 'node-cron';
import { despacharRutasDelDia, liberarColasPendientes } from '../services/despachoRutas.service';

/**
 * Cron de despacho matutino de rutas confirmadas:
 * Se ejecuta todos los días a las 07:30 AM (hora de Mendoza / Argentina).
 * Si hay rutas confirmadas para hoy cuyo chofer aún no recibió su primera parada,
 * se la despacha automáticamente por WhatsApp.
 *
 * También hace una pasada preventiva cada 15 minutos en horario diurno (07:30 a 20:00)
 * por si el servidor se reinició o una ruta del día se confirmó después.
 */
export function iniciarCronDespachoRutas(): void {
  // 1) Disparo matutino puntual a las 07:30 AM
  cron.schedule(
    '30 7 * * *',
    () => {
      console.log('[cron-despacho] 🌅 Ejecutando despacho matutino de rutas (07:30 AM)...');
      despacharRutasDelDia().catch((err) => console.error('[cron-despacho] Error:', err.message));
    },
    { timezone: 'America/Argentina/Mendoza' },
  );

  // 2) Red de seguridad: cada 15 min entre las 08:00 y las 19:45
  cron.schedule(
    '*/15 8-19 * * *',
    () => {
      despacharRutasDelDia().catch((err) => console.error('[cron-despacho-seguridad] Error:', err.message));
    },
    { timezone: 'America/Argentina/Mendoza' },
  );

  // 3) Cola de avisos de choferes que dejaron un paso a medias (no mandaron
  // la foto, no contestaron el cobro): al vencerse su sesión quedan libres y
  // les llega lo que tenían en cola.
  cron.schedule(
    '*/2 7-21 * * *',
    () => {
      liberarColasPendientes().catch((err) => console.error('[cron-cola-choferes] Error:', err.message));
    },
    { timezone: 'America/Argentina/Mendoza' },
  );

  // 4) Chequeo al arrancar el proceso si está dentro del horario diurno (07:30 a 20:00 Mendoza)
  const ahora = new Date();
  const horaMendoza = (ahora.getUTCHours() - 3 + 24) % 24;
  const minutoMendoza = ahora.getUTCMinutes();
  if ((horaMendoza > 7 || (horaMendoza === 7 && minutoMendoza >= 30)) && horaMendoza < 20) {
    despacharRutasDelDia().catch((err) => console.error('[cron-despacho-inicio] Error:', err.message));
  }

  console.log('⏰ Cron de despacho de rutas activo (07:30 AM Mendoza)');
}
