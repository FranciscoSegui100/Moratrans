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
              v.cliente_telefono, cl.nombre AS cliente_nombre
         FROM contenedores c
         JOIN viajes v ON v.contenedor_numero = c.numero AND v.tipo = 'entrega'
         LEFT JOIN clientes cl ON cl.telefono = v.cliente_telefono
        WHERE c.estado = 'entregado'
          AND c.vence_en IS NOT NULL
          AND c.vence_en BETWEEN now() AND now() + interval '48 hours'
          AND v.cliente_telefono IS NOT NULL
          -- Evita enviar más de un aviso por WhatsApp para el mismo contenedor cada 24 horas:
          AND NOT EXISTS (
            SELECT 1 FROM mensajes_chat m
             WHERE m.telefono = v.cliente_telefono
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
