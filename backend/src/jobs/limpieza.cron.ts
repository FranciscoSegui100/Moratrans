import cron from 'node-cron';
import path from 'path';
import { query } from '../config/db';
import { decrypt } from '../services/crypto.service';
import { borrarArchivo } from '../services/storage.service';

/**
 * Retención de tablas que solo crecen (auditoría / dedup de webhooks) — sin
 * esto, crecen para siempre. auth_eventos se "reinicia" mensualmente (solo
 * queda el último mes); el dedup de mensajes de WhatsApp tampoco sirve
 * pasado el mes (schema.sql ya lo sugería, nunca se había implementado).
 */
const RETENCION_DIAS: Record<string, number> = {
  mensajes_procesados: 30,
  historial_contenedores: 180,
  auth_eventos: 30,
};

// Sección 9 (Ley 25.326 — guardar datos sensibles solo el tiempo necesario).
const RETENCION_COMPROBANTES_DIAS = 730; // 2 años desde creado_en
const RETENCION_DNI_INACTIVO_DIAS = 365; // 1 año desde que el chofer quedó inactivo

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

/** Borra un archivo del storage a partir de su ruta cifrada; no falla el cron si el archivo ya no está. */
async function purgarArchivo(rutaCifrada: string | null, prefijo: string): Promise<void> {
  if (!rutaCifrada) return;
  const filename = path.basename(decrypt(rutaCifrada));
  try {
    await borrarArchivo(`${prefijo}/${filename}`);
  } catch (e) {
    console.error(`[limpieza] no se pudo borrar ${prefijo}/${filename} del storage:`, e);
  }
}

/**
 * Purga comprobantes/facturas de pago vencidos: se conserva la fila de
 * `pagos` (monto, estado, fechas) para trazabilidad contable/impositiva,
 * pero se borra el archivo del storage y se limpia la referencia cifrada —
 * es el dato sensible en sí (sección 9, caso "retención de comprobantes").
 */
async function purgarComprobantesViejos(): Promise<void> {
  const pagosViejos = await query<{ id: string; url_comprobante: string | null; factura_url: string | null }>(
    `SELECT id, url_comprobante, factura_url FROM pagos
      WHERE creado_en < now() - make_interval(days => $1)
        AND (url_comprobante IS NOT NULL OR factura_url IS NOT NULL)`,
    [RETENCION_COMPROBANTES_DIAS],
  );
  for (const p of pagosViejos) {
    await purgarArchivo(p.url_comprobante, 'comprobantes');
    await purgarArchivo(p.factura_url, 'facturas');
  }
  if (pagosViejos.length > 0) {
    await query(
      `UPDATE pagos SET url_comprobante = NULL, factura_url = NULL
        WHERE creado_en < now() - make_interval(days => $1)`,
      [RETENCION_COMPROBANTES_DIAS],
    );
    console.log(`[limpieza] pagos: ${pagosViejos.length} comprobantes/facturas > ${RETENCION_COMPROBANTES_DIAS} días purgados`);
  }

  const adjuntosViejos = await query<{ id: string; url_comprobante: string }>(
    `SELECT id, url_comprobante FROM pagos_adjuntos WHERE creado_en < now() - make_interval(days => $1)`,
    [RETENCION_COMPROBANTES_DIAS],
  );
  for (const a of adjuntosViejos) {
    await purgarArchivo(a.url_comprobante, 'comprobantes');
  }
  if (adjuntosViejos.length > 0) {
    await query(`DELETE FROM pagos_adjuntos WHERE creado_en < now() - make_interval(days => $1)`, [
      RETENCION_COMPROBANTES_DIAS,
    ]);
    console.log(`[limpieza] pagos_adjuntos: ${adjuntosViejos.length} comprobantes > ${RETENCION_COMPROBANTES_DIAS} días purgados`);
  }
}

/**
 * Anonimiza el DNI de choferes que llevan más de un año inactivos (sección
 * 9, caso "retención de DNI"): sin esto quedaba colgado en la base para
 * siempre apenas se desactivaba a alguien. Se conserva el resto de la fila
 * (nombre, viajes, historial) para trazabilidad operativa.
 */
async function anonimizarChoferesInactivos(): Promise<void> {
  const anonimizados = await query(
    `UPDATE choferes SET dni_enc = NULL, dni_hash = NULL
      WHERE activo = FALSE
        AND desactivado_en < now() - make_interval(days => $1)
        AND dni_hash IS NOT NULL
      RETURNING 1`,
    [RETENCION_DNI_INACTIVO_DIAS],
  );
  if (anonimizados.length > 0) {
    console.log(`[limpieza] choferes: ${anonimizados.length} DNIs anonimizados (inactivos > ${RETENCION_DNI_INACTIVO_DIAS} días)`);
  }
}

/** Corre una vez por mes (madrugada del día 1). */
export function iniciarCronLimpieza(): void {
  cron.schedule('0 4 1 * *', () => {
    limpiarTablasViejas().catch((e) => console.error('[limpieza] error:', e));
    purgarComprobantesViejos().catch((e) => console.error('[limpieza] error purgando comprobantes:', e));
    anonimizarChoferesInactivos().catch((e) => console.error('[limpieza] error anonimizando choferes:', e));
  });
  console.log('🧹 Cron de limpieza activo (mensual, día 1 04:00)');
}
