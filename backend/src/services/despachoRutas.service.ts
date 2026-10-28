import { query } from '../config/db';
import { emitRecursoActualizado } from '../config/socket';
import { avisarChoferViaje, avisarChoferRecambio } from '../modules/viajes/viajes.routes';
import { motivoErrorWa } from '../modules/whatsapp/graphApi';
import { notificarEnvioFallido } from '../modules/whatsapp/alertaEnvio';
import { hoyMendozaISO } from './fechas.service';

/**
 * Despacha la primera parada pendiente de una ruta al chofer por WhatsApp
 * y marca `chofer_notificado_en = now()`. Si la parada ya fue notificada o
 * no hay paradas pendientes confirmadas, no hace nada.
 */
export async function despacharPrimeraParada(rutaId: string, choferId: string): Promise<boolean> {
  const [primeraPendiente] = await query<{ orden: number | null }>(
    `SELECT MIN(orden) AS orden FROM viajes
      WHERE ruta_id = $1 AND ruta_confirmada_en IS NOT NULL
        AND estado IN ('programado', 'en_curso') AND completada_en IS NULL`,
    [rutaId],
  );
  if (primeraPendiente?.orden == null) return false;

  const visitas = await query<{
    id: string; tipo: 'entrega' | 'retiro'; contenedor_numero: string | null; destino_direccion: string | null;
    ubicacion_id: string | null; grupo_id: string | null; cliente_telefono: string | null;
    hora_estimada: string | null; pago_id: string | null; chofer_notificado_en: string | null;
  }>(
    `SELECT id, tipo, contenedor_numero, destino_direccion, ubicacion_id, grupo_id,
            cliente_telefono, hora_estimada, pago_id, chofer_notificado_en
       FROM viajes
      WHERE ruta_id = $1 AND orden = $2 AND ruta_confirmada_en IS NOT NULL
        AND estado IN ('programado', 'en_curso') AND completada_en IS NULL`,
    [rutaId, primeraPendiente.orden],
  );
  if (visitas.length === 0) return false;

  // Evita re-enviar si el chofer ya tiene esta parada notificada
  if (visitas.some((v) => v.chofer_notificado_en != null)) {
    return false;
  }

  const entrega = visitas.find((v) => v.tipo === 'entrega');
  const retiro = visitas.find((v) => v.tipo === 'retiro');
  let aviso: Promise<void>;
  let referenciaId: string;

  if (entrega?.grupo_id && retiro) {
    aviso = avisarChoferRecambio(
      choferId, retiro.contenedor_numero!, entrega.contenedor_numero, entrega.ubicacion_id,
      entrega.destino_direccion, entrega.cliente_telefono ?? retiro.cliente_telefono,
      entrega.hora_estimada, retiro.pago_id ?? entrega.pago_id,
    );
    referenciaId = retiro.id;
  } else {
    const v = entrega ?? retiro!;
    aviso = avisarChoferViaje(choferId, v.tipo, v.contenedor_numero, v.destino_direccion, v.cliente_telefono, v.hora_estimada, v.pago_id, v.id);
    referenciaId = v.id;
  }

  // Marca el viaje como notificado al chofer
  await query(
    `UPDATE viajes SET chofer_notificado_en = now() WHERE id = ANY($1)`,
    [visitas.map((v) => v.id)],
  );

  aviso.catch((e: any) => {
    const motivo = motivoErrorWa(e);
    console.error(`[despacho] Error avisando al chofer la primera parada de ruta ${rutaId}:`, motivo);
    notificarEnvioFallido(referenciaId, `chofer de la ruta ${rutaId}`, 'aviso de primera parada', motivo).catch(
      (e2) => console.error('[despacho] Error registrando alerta de envío fallido:', e2),
    );
  });

  return true;
}

/**
 * Busca todas las rutas de la fecha indicada (por defecto HOY en Mendoza)
 * que tengan paradas confirmadas pendientes de despacho al chofer,
 * y les envía su primera parada por WhatsApp.
 */
export async function despacharRutasDelDia(fecha?: string): Promise<{ despachadas: number }> {
  const fechaTarget = fecha ?? hoyMendozaISO();
  const rutas = await query<{ id: string; chofer_id: string; chofer_nombre: string }>(
    `SELECT DISTINCT r.id, r.chofer_id, c.nombre AS chofer_nombre
       FROM rutas r
       JOIN viajes v ON v.ruta_id = r.id
       JOIN choferes c ON c.id = r.chofer_id
      WHERE r.fecha = $1
        AND v.ruta_confirmada_en IS NOT NULL
        AND v.completada_en IS NULL
        AND v.estado IN ('programado', 'en_curso')
        AND v.chofer_notificado_en IS NULL`,
    [fechaTarget],
  );

  let despachadas = 0;
  for (const r of rutas) {
    try {
      const ok = await despacharPrimeraParada(r.id, r.chofer_id);
      if (ok) {
        despachadas++;
        console.log(`[despacho] Ruta ${r.id} despachada al chofer ${r.chofer_nombre} para el día ${fechaTarget}`);
      }
    } catch (err: any) {
      console.error(`[despacho] Error despachando ruta ${r.id} (${r.chofer_nombre}):`, err);
    }
  }

  if (despachadas > 0) {
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('rutas');
  }

  return { despachadas };
}
