import cron from 'node-cron';
import { query } from '../config/db';
import { emitAlerta } from '../config/socket';
import { sendButtons } from '../modules/whatsapp/graphApi';

/**
 * Inserta alertas nuevas (evitando duplicados por el índice único parcial)
 * y las empuja por Socket.io a la sala 'alertas'.
 */
async function generarAlertas(): Promise<void> {
  // 1) Contenedores que vencen en las próximas 48h (alerta interna para panel)
  const porVencer = await query<{ id: string; tipo: string; referencia_id: string; mensaje: string; creado_en: string }>(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     SELECT 'contenedor_por_vencer', numero,
            'Contenedor ' || numero || ' vence el ' || to_char(vence_en, 'DD/MM HH24:MI')
       FROM contenedores
      WHERE vence_en IS NOT NULL
        AND vence_en BETWEEN now() AND now() + interval '48 hours'
        AND estado IN ('reservado', 'entregado')
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, creado_en`,
  );

  // 1.a) Contenedores ya vencidos que siguen con el cliente sin retiro
  // programado. La alerta de arriba solo mira las próximas 48h: pasada la
  // fecha, el contenedor no generaba nada más y quedaba en la calle sin que
  // nadie lo notara. Mismo criterio que el estado "Vencido" de la pestaña
  // Contenedores (estado_contrato en contenedores.routes.ts) y que el KPI del
  // Dashboard — mantener los tres en sync.
  const vencidosEnCalle = `
    SELECT c.numero, c.vence_en FROM contenedores c
     WHERE c.estado = 'entregado' AND c.vence_en IS NOT NULL AND c.vence_en < now()
       AND NOT EXISTS (
         SELECT 1 FROM viajes v
          WHERE v.contenedor_numero = c.numero AND v.tipo = 'retiro' AND v.estado IN ('programado', 'en_curso')
       )`;
  const contenedoresVencidos = await query<{ id: string; tipo: string; referencia_id: string; mensaje: string; creado_en: string }>(
    `INSERT INTO alertas (tipo, referencia_id, mensaje)
     SELECT 'contenedor_vencido', numero,
            'Contenedor ' || numero || ' venció el ' || to_char(vence_en, 'DD/MM') || ' y sigue con el cliente sin retiro programado'
       FROM (${vencidosEnCalle}) vc
     ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
     RETURNING id, tipo, referencia_id, mensaje, creado_en`,
  );
  // Se resuelven solas cuando dejan de aplicar (se lo retiró, se programó el
  // retiro o se extendió el plazo) — y la de "por vencer" de un contenedor
  // que ya venció también, para no tener dos alertas por lo mismo.
  await query(
    `UPDATE alertas SET estado = 'resuelta'
      WHERE estado <> 'resuelta'
        AND (
          (tipo = 'contenedor_vencido' AND referencia_id NOT IN (SELECT numero FROM (${vencidosEnCalle}) vc))
          OR (tipo = 'contenedor_por_vencer' AND referencia_id IN (SELECT numero FROM (${vencidosEnCalle}) vc))
        )`,
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
               AND m.texto LIKE '%Contenedor ' || c.numero || '%'
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

  const nuevas = [...porVencer, ...contenedoresVencidos, ...vencidos];
  for (const a of nuevas) emitAlerta(a);
  if (nuevas.length > 0) {
    console.log(`[cron] ${nuevas.length} alertas generadas`);
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
