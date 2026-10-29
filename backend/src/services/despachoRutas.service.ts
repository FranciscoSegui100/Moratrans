import { query } from '../config/db';
import { emitRecursoActualizado } from '../config/socket';
import { avisarChoferViaje, avisarChoferRecambio } from '../modules/viajes/viajes.routes';
import { motivoErrorWa } from '../modules/whatsapp/graphApi';
import { notificarEnvioFallido } from '../modules/whatsapp/alertaEnvio';
import { hoyMendozaISO } from './fechas.service';

type VisitaPendiente = {
  id: string; tipo: 'entrega' | 'retiro'; contenedor_numero: string | null; destino_direccion: string | null;
  ubicacion_id: string | null; grupo_id: string | null; cliente_telefono: string | null;
  hora_estimada: string | null; pago_id: string | null; chofer_notificado_en: string | null;
};

export type ResultadoDespacho = 'enviada' | 'encolada' | 'nada';

/**
 * Pasos del bot en los que el chofer está en medio de algo: escribiendo o
 * confirmando el contenedor, mandando la foto o contestando el cobro.
 */
const PASOS_OCUPADO = [
  'elegir_contenedor',
  'elegir_contenedor_entrega',
  'confirmar_contenedor_entrega',
  'esperando_foto_entrega',
  'esperando_cobro',
];

/**
 * ¿El chofer está ocupado con otra cosa? Sí si tiene una parada avisada sin
 * terminar (o un vaciado avisado sin hacer) de las últimas 12 horas — una
 * vieja que quedó colgada no lo bloquea para siempre —, o, con
 * `mirarSesion`, si está en medio de un paso del bot (misma vida que la
 * sesión: 10 minutos sin actividad). Al liberar la cola no se mira la
 * sesión: se libera justo cuando el flujo termina.
 */
export async function choferOcupado(choferId: string, opciones: { mirarSesion?: boolean } = {}): Promise<boolean> {
  const [r] = await query<{ ocupado: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM viajes v LEFT JOIN rutas r ON r.id = v.ruta_id
          WHERE COALESCE(r.chofer_id, v.chofer_id) = $1
            AND v.chofer_notificado_en > now() - interval '12 hours'
            AND v.completada_en IS NULL AND v.estado IN ('programado', 'en_curso'))
       OR EXISTS (
         SELECT 1 FROM ruta_vaciados rv
           JOIN rutas r ON r.id = rv.ruta_id
           JOIN contenedores c ON c.numero = rv.contenedor_numero
          WHERE r.chofer_id = $1 AND rv.chofer_notificado_en > now() - interval '12 hours' AND c.estado = 'retirado')
       OR ($2::boolean AND EXISTS (
         SELECT 1 FROM sesiones_chat s JOIN choferes ch ON ch.telefono = s.telefono
          WHERE ch.id = $1 AND s.flujo = 'chofer' AND s.paso = ANY($3::text[])
            AND s.actualizado_en > now() - interval '10 minutes'))
     ) AS ocupado`,
    [choferId, opciones.mirarSesion ?? false, PASOS_OCUPADO],
  );
  return r?.ocupado ?? false;
}

async function encolar(choferId: string, item: { rutaId: string } | { viajeId: string }): Promise<void> {
  if ('rutaId' in item) {
    await query(
      `INSERT INTO cola_avisos_chofer (chofer_id, ruta_id) VALUES ($1, $2)
       ON CONFLICT (chofer_id, ruta_id) WHERE ruta_id IS NOT NULL DO NOTHING`,
      [choferId, item.rutaId],
    );
  } else {
    await query(
      `INSERT INTO cola_avisos_chofer (chofer_id, viaje_id) VALUES ($1, $2)
       ON CONFLICT (chofer_id, viaje_id) WHERE viaje_id IS NOT NULL DO NOTHING`,
      [choferId, item.viajeId],
    );
  }
}

/** Primera parada confirmada y pendiente de la ruta, si todavía no se le avisó al chofer. */
async function primeraVisitaPendiente(rutaId: string): Promise<VisitaPendiente[] | null> {
  const [primeraPendiente] = await query<{ orden: number | null }>(
    `SELECT MIN(orden) AS orden FROM viajes
      WHERE ruta_id = $1 AND ruta_confirmada_en IS NOT NULL
        AND estado IN ('programado', 'en_curso') AND completada_en IS NULL`,
    [rutaId],
  );
  if (primeraPendiente?.orden == null) return null;

  const visitas = await query<VisitaPendiente>(
    `SELECT id, tipo, contenedor_numero, destino_direccion, ubicacion_id, grupo_id,
            cliente_telefono, hora_estimada, pago_id, chofer_notificado_en
       FROM viajes
      WHERE ruta_id = $1 AND orden = $2 AND ruta_confirmada_en IS NOT NULL
        AND estado IN ('programado', 'en_curso') AND completada_en IS NULL`,
    [rutaId, primeraPendiente.orden],
  );
  if (visitas.length === 0) return null;
  // Evita re-enviar si el chofer ya tiene esta parada notificada
  if (visitas.some((v) => v.chofer_notificado_en != null)) return null;
  return visitas;
}

/** Le manda al chofer la parada `visitas` y la marca como notificada. */
async function enviarVisita(rutaId: string, choferId: string, visitas: VisitaPendiente[]): Promise<void> {
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
}

/**
 * Despacha la primera parada pendiente de una ruta al chofer por WhatsApp
 * y marca `chofer_notificado_en = now()`. Si el chofer está en medio de otra
 * cosa (otra ruta, una entrega a medias), la ruta queda en su cola y le
 * llega cuando termina (liberarColaChofer). Si la parada ya fue notificada o
 * no hay paradas pendientes confirmadas, no hace nada.
 */
export async function despacharPrimeraParada(rutaId: string, choferId: string): Promise<ResultadoDespacho> {
  const visitas = await primeraVisitaPendiente(rutaId);
  if (!visitas) return 'nada';
  if (await choferOcupado(choferId, { mirarSesion: true })) {
    await encolar(choferId, { rutaId });
    return 'encolada';
  }
  await enviarVisita(rutaId, choferId, visitas);
  return 'enviada';
}

/**
 * Aviso de un viaje suelto (asignado a un chofer fuera de una ruta, o al
 * cambiarle el chofer): se manda ya, o queda en la cola si el chofer está
 * ocupado. Un recambio se avisa como una sola visita (lleno + vacío).
 */
export async function avisarOEncolarViaje(choferId: string, viajeId: string): Promise<ResultadoDespacho> {
  if (await choferOcupado(choferId, { mirarSesion: true })) {
    await encolar(choferId, { viajeId });
    return 'encolada';
  }
  return (await enviarAvisoViaje(choferId, viajeId)) ? 'enviada' : 'nada';
}

async function enviarAvisoViaje(choferId: string, viajeId: string): Promise<boolean> {
  const [v] = await query<VisitaPendiente & { chofer_id: string | null; ruta_id: string | null; estado: string; completada_en: string | null }>(
    `SELECT id, tipo, contenedor_numero, destino_direccion, ubicacion_id, grupo_id, cliente_telefono,
            hora_estimada, pago_id, chofer_notificado_en, chofer_id, ruta_id, estado, completada_en
       FROM viajes WHERE id = $1`,
    [viajeId],
  );
  // Ya no es de este chofer, se canceló o ya se hizo: no hay nada que avisar.
  if (!v || v.chofer_id !== choferId || !['programado', 'en_curso'].includes(v.estado) || v.completada_en) return false;

  let ids = [v.id];
  try {
    if (v.grupo_id) {
      const pareja = await query<{ id: string; tipo: string; contenedor_numero: string | null; ubicacion_id: string | null; pago_id: string | null }>(
        `SELECT id, tipo, contenedor_numero, ubicacion_id, pago_id FROM viajes
          WHERE grupo_id = $1 AND estado IN ('programado', 'en_curso') AND completada_en IS NULL`,
        [v.grupo_id],
      );
      const retiro = pareja.find((p) => p.tipo === 'retiro');
      const entrega = pareja.find((p) => p.tipo === 'entrega');
      if (!retiro?.contenedor_numero) return false; // sin el lleno asignado no hay nada útil que avisar
      await avisarChoferRecambio(
        choferId, retiro.contenedor_numero, entrega?.contenedor_numero ?? null, entrega?.ubicacion_id ?? null,
        v.destino_direccion, v.cliente_telefono, v.hora_estimada, retiro.pago_id ?? entrega?.pago_id ?? null,
      );
      ids = pareja.map((p) => p.id);
    } else {
      await avisarChoferViaje(choferId, v.tipo, v.contenedor_numero, v.destino_direccion, v.cliente_telefono, v.hora_estimada, v.pago_id, v.id);
    }
  } catch (e: any) {
    const motivo = motivoErrorWa(e);
    console.error('[despacho] Error avisando al chofer un viaje:', motivo);
    notificarEnvioFallido(v.id, `chofer del viaje ${v.id}`, 'aviso de viaje asignado', motivo).catch(
      (e2) => console.error('[despacho] Error registrando alerta de envío fallido:', e2),
    );
    return false;
  }
  // Sueltos (sin ruta): se marcan avisados para que cuenten como "ocupado"
  // hasta que los complete. Los de una ruta los marca su propio despacho.
  if (!v.ruta_id) {
    await query(`UPDATE viajes SET chofer_notificado_en = now() WHERE id = ANY($1) AND ruta_id IS NULL`, [ids]);
  }
  return true;
}

/**
 * El chofer terminó lo que estaba haciendo (sin próxima parada en su ruta):
 * le llega lo más viejo de su cola. De a uno — mientras haga eso vuelve a
 * estar ocupado, y lo siguiente sale cuando lo termine. Lo que ya no tiene
 * sentido (ruta reasignada o sin paradas, viaje hecho o cancelado) se
 * descarta. Devuelve true si le mandó algo (el llamador no manda el menú).
 */
export async function liberarColaChofer(choferId: string): Promise<boolean> {
  if (await choferOcupado(choferId)) return false;
  const items = await query<{ id: string; ruta_id: string | null; viaje_id: string | null }>(
    `SELECT id, ruta_id, viaje_id FROM cola_avisos_chofer WHERE chofer_id = $1 ORDER BY creado_en`,
    [choferId],
  );
  for (const item of items) {
    // Se saca antes de mandar: dos liberaciones a la vez no lo mandan dos veces.
    const [tomado] = await query('DELETE FROM cola_avisos_chofer WHERE id = $1 RETURNING id', [item.id]);
    if (!tomado) continue;
    if (item.ruta_id) {
      const [ruta] = await query<{ chofer_id: string | null }>('SELECT chofer_id FROM rutas WHERE id = $1', [item.ruta_id]);
      if (ruta?.chofer_id !== choferId) continue;
      const visitas = await primeraVisitaPendiente(item.ruta_id);
      if (!visitas) continue;
      await enviarVisita(item.ruta_id, choferId, visitas);
    } else if (!(await enviarAvisoViaje(choferId, item.viaje_id!))) {
      continue;
    }
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('rutas');
    return true;
  }
  return false;
}

/**
 * Red de seguridad para las colas: un chofer que dejó un paso a medias (no
 * mandó la foto, no contestó el cobro) queda libre cuando se le vence la
 * sesión, pero ningún mensaje suyo dispara la liberación. Lo corre el cron.
 */
export async function liberarColasPendientes(): Promise<void> {
  const choferes = await query<{ chofer_id: string }>('SELECT DISTINCT chofer_id FROM cola_avisos_chofer');
  for (const c of choferes) {
    if (await choferOcupado(c.chofer_id, { mirarSesion: true })) continue;
    await liberarColaChofer(c.chofer_id).catch((e) => console.error('[despacho] Error liberando cola de chofer:', e.message));
  }
}

/**
 * Busca todas las rutas de la fecha indicada (por defecto HOY en Mendoza)
 * que tengan paradas confirmadas pendientes de despacho al chofer,
 * y les envía su primera parada por WhatsApp (o la deja en su cola si está
 * ocupado).
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
      const resultado = await despacharPrimeraParada(r.id, r.chofer_id);
      if (resultado === 'enviada') {
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
