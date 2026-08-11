import cron from 'node-cron';
import { query } from '../config/db';

/**
 * Retención de tablas que solo crecen (auditoría / dedup de webhooks) — sin
 * esto, crecen para siempre. Valores conservadores: no hay razón operativa
 * para revisar historial de contenedores de hace más de 6 meses, ni eventos
 * de auth de más de un año; el dedup de mensajes de WhatsApp no sirve pasado
 * el mes (schema.sql ya lo sugería, nunca se había implementado).
 */
const RETENCION_DIAS: Record<string, number> = {
  mensajes_procesados: 30,
  historial_contenedores: 180,
  auth_eventos: 365,
};

async function limpiarTablasViejas(): Promise<void> {
  for (const [tabla, dias] of Object.entries(RETENCION_DIAS)) {
    const borradas = await query(
      `DELETE FROM ${tabla} WHERE creado_en < now() - make_interval(days => $1) RETURNING 1`,
      [dias],
    );
    if (borradas.length > 0) {
      console.log(`[limpieza] ${tabla}: ${borradas.length} filas > ${dias} días borradas`);
    }
  }
}

/** Corre una vez por día (madrugada). */
export function iniciarCronLimpieza(): void {
  cron.schedule('0 4 * * *', () => {
    limpiarTablasViejas().catch((e) => console.error('[limpieza] error:', e));
  });
  console.log('🧹 Cron de limpieza activo (diario 04:00)');
}
