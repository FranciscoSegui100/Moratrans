import cron from 'node-cron';
import { query } from '../config/db';
import { emitAlerta, emitAlertaActualizada } from '../config/socket';
import { sendButtons } from '../modules/whatsapp/graphApi';
import { formatearFechaLarga } from '../services/diasHabiles.service';
import { hoyMendozaISO } from '../services/fechas.service';
import { NOTA_RETIRO_AUTOMATICO, sincronizarRetirosPorVencimiento } from '../services/retiroAutomatico.service';

/**
 * Inserta alertas nuevas (evitando duplicados por el índice único parcial)
 * y las empuja por Socket.io a la sala 'alertas'.
 */
export async function generarAlertas(): Promise<void> {
  // 1) Alertas para contenedores que vencen en las próximas 48h
  // Si todavía no venció (BETWEEN now() AND now() + 48h), muestra "vence el DD/MM".
  // Si ya venció, la sección 1.c de abajo se encarga de crear el viaje de retiro y
  // emitir la alerta correspondiente para que el operador lo asigne en Rutas.
  const porVencer = await query<{ id: string; tipo: string; referencia_id: string; mensaje: string; creado_en: string }>(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     SELECT 'contenedor_por_vencer', numero,
            'Contenedor ' || numero || ' vence el ' || to_char(vence_en, 'DD/MM HH24:MI')
       FROM contenedores
      WHERE vence_en IS NOT NULL
        AND vence_en BETWEEN now() AND now() + interval '48 hours'
        AND estado IN ('reservado', 'entregado')
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta'
       DO UPDATE SET mensaje = EXCLUDED.mensaje, estado = 'nueva'
       WHERE alertas.mensaje IS DISTINCT FROM EXCLUDED.mensaje
     RETURNING id, tipo, referencia_id, mensaje, creado_en`,
  );

  // 1.b) Notificación directa por WhatsApp al cliente (24-48h antes del vencimiento)
  // Avisa al cliente que su alquiler está por vencer y le ofrece botones para alargar o pedir retiro.
  try {
    const clientesAvisar = await query<{
      numero: string;
      vence_en: string;
      cliente_telefono: string;
      cliente_nombre: string | null;
    }>(
      `SELECT c.numero, to_char(c.vence_en, 'DD/MM HH24:MI') AS vence_en,
              ultima.cliente_telefono, cl.nombre AS cliente_nombre
         FROM contenedores c
         CROSS JOIN LATERAL (
           SELECT v.cliente_telefono
             FROM viajes v
            WHERE v.contenedor_numero = c.numero AND v.tipo = 'entrega' AND v.estado <> 'cancelado'
            ORDER BY v.creado_en DESC LIMIT 1
         ) ultima
         LEFT JOIN clientes cl ON cl.telefono = ultima.cliente_telefono
        WHERE c.estado = 'entregado'
          AND c.vence_en IS NOT NULL
          AND c.vence_en BETWEEN now() AND now() + interval '48 hours'
          AND ultima.cliente_telefono IS NOT NULL
          -- Evita enviar más de un aviso por WhatsApp para el mismo contenedor cada 24 horas:
          AND NOT EXISTS (
            SELECT 1 FROM mensajes_chat m
             WHERE m.telefono = ultima.cliente_telefono
               AND m.origen = 'bot'
               -- Tiene que coincidir con el texto que se manda abajo ("del
               -- contenedor *X* vence"): antes buscaba "Contenedor X" (con
               -- mayúscula y sin asteriscos), nunca encontraba el aviso ya
               -- enviado y lo repetía en cada corrida del cron (cada 15 min).
               AND m.texto LIKE '%contenedor *' || c.numero || '* vence%'
               AND m.creado_en > now() - interval '24 hours'
          )`,
    );

    for (const ca of clientesAvisar) {
      const nombre = ca.cliente_nombre && ca.cliente_nombre !== 'Sin nombre' ? ` ${ca.cliente_nombre}` : '';
      const cuerpo =
        `Hola${nombre} 👋 Te recordamos que el alquiler del contenedor *${ca.numero}* vence el *${ca.vence_en} hs*.\n\n` +
        `Si ya terminaste podés pedir el retiro, o si necesitás más días podés solicitar una extensión directamente:`;
      const botones = [
        { id: 'opt_alargar_retiro', title: '⏳ Extender alquiler' },
        { id: 'opt_pedir_retiro', title: '📥 Pedir retiro' },
      ];
      sendButtons(ca.cliente_telefono, cuerpo, botones).catch((e) =>
        console.error(`[cron] Error enviando aviso de vencimiento a ${ca.cliente_telefono}:`, e.message),
      );
    }
  } catch (err: any) {
    console.error('[cron] Error procesando avisos de vencimiento por WhatsApp a clientes:', err.message);
  }

  // 1.c) Retiro automático EN CUANTO SE SABE el vencimiento: cada contenedor
  // entregado tiene su retiro en la bolsa del día que vence (lunes si cae
  // sábado/domingo), y se mueve solo si el vencimiento cambia — ver
  // sincronizarRetirosPorVencimiento. El aviso al operador
  // ('retiro_solicitado') NO sale acá, recién cuando está próximo/vencido de
  // verdad (ver 1.d, más abajo).
  try {
    await sincronizarRetirosPorVencimiento();
  } catch (err: any) {
    console.error('[cron] Error creando retiros automáticos por vencimiento:', err.message);
  }

  // 1.d) Aviso al operador cuando un retiro automático (ver 1.c) ya está
  // próximo o vencido (fecha <= hoy): recién acá se resuelve la alerta
  // 'contenedor_por_vencer' y se levanta 'retiro_solicitado' — el viaje
  // puede llevar días ya en la bolsa (creado con anticipación en 1.c), y acá
  // es donde de verdad hace falta que alguien lo asigne. El `NOT EXISTS`
  // evita repetir la alerta en cada corrida del cron (cada 15 min) mientras
  // siga sin resolverse. Al cliente NO se le manda nada acá (ya recibió el
  // recordatorio de 24-48hs con los botones de extender / pedir retiro).
  try {
    const hoy = hoyMendozaISO();
    const vencidosOProximos = await query<{ contenedor_numero: string; fecha: string; cliente_telefono: string | null }>(
      `SELECT v.contenedor_numero, v.fecha, v.cliente_telefono FROM viajes v
        WHERE v.tipo = 'retiro' AND v.estado = 'programado' AND v.notas = $1 AND v.fecha <= $2
          AND NOT EXISTS (
            SELECT 1 FROM alertas a
             WHERE a.tipo = 'retiro_solicitado' AND a.referencia_id = v.contenedor_numero AND a.estado <> 'resuelta'
          )`,
      [NOTA_RETIRO_AUTOMATICO, hoy],
    );

    for (const v of vencidosOProximos) {
      await query(
        `UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'contenedor_por_vencer' AND referencia_id = $1`,
        [v.contenedor_numero],
      );
      emitAlertaActualizada({ tipo: 'contenedor_por_vencer', referencia_id: v.contenedor_numero, estado: 'resuelta' });

      const yaVencido = v.fecha < hoy;
      const mensajeAlerta = yaVencido
        ? `Contenedor ${v.contenedor_numero} YA VENCIÓ — retiro agregado a la bolsa para el ${formatearFechaLarga(v.fecha)} (Listo en Rutas)`
        : `Contenedor ${v.contenedor_numero} vence HOY — retiro agregado a la bolsa de hoy (Listo en Rutas)`;
      const [alertaRetiro] = await query<{ id: string; tipo: string; referencia_id: string; mensaje: string; creado_en: string }>(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('retiro_solicitado', $1, $2)
         ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta'
           DO UPDATE SET mensaje = EXCLUDED.mensaje, estado = 'nueva'
         RETURNING id, tipo, referencia_id, mensaje, creado_en`,
        [v.contenedor_numero, mensajeAlerta],
      );
      if (alertaRetiro) {
        emitAlerta({ ...alertaRetiro, cliente_telefono: v.cliente_telefono });
      }
    }
  } catch (err: any) {
    console.error('[cron] Error avisando retiros automáticos próximos/vencidos:', err.message);
  }

  // 2) Pagos pendientes hace más de 24h (vencidos de validación)
  const vencidos = await query<{ id: string; tipo: string; referencia_id: string; mensaje: string; creado_en: string }>(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     SELECT 'pago_vencido', id::text,
            'Pago ' || id || ' lleva más de 24h sin validar'
       FROM pagos
      WHERE estado = 'pendiente' AND creado_en < now() - interval '24 hours'
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, creado_en`,
  );

  for (const a of [...porVencer, ...vencidos]) emitAlerta(a);
  if (porVencer.length + vencidos.length > 0) {
    console.log(`[cron] ${porVencer.length + vencidos.length} alertas generadas`);
  }
}

/** Programa el cron cada 15 minutos. */
export function iniciarCronAlertas(): void {
  cron.schedule('*/15 * * * *', () => {
    generarAlertas().catch((e) => console.error('[cron] error:', e));
  });
  // Corrida inicial al arrancar
  generarAlertas().catch((e) => console.error('[cron] error inicial:', e));
  console.log('⏰ Cron de alertas activo (cada 15 min)');
}
