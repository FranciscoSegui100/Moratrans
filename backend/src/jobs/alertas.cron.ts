import cron from 'node-cron';
import { query } from '../config/db';
import { emitAlerta, emitAlertaActualizada, emitRecursoActualizado } from '../config/socket';
import { sendButtons, sendText } from '../modules/whatsapp/graphApi';
import { proximosDiasHabiles, formatearFechaLarga } from '../services/diasHabiles.service';
import { resolverUbicacion } from '../services/ubicaciones.service';

/**
 * Inserta alertas nuevas (evitando duplicados por el índice único parcial)
 * y las empuja por Socket.io a la sala 'alertas'.
 */
async function generarAlertas(): Promise<void> {
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

  // 1.c) Contenedores vencidos (vence_en < now() y estado = 'entregado'):
  // Si el cliente no pidió retiro ni extensión y el plazo finalizó:
  // - Se crea automáticamente el viaje de retiro para el próximo día hábil (entrando en la Bolsa de Rutas).
  // - Se resuelve cualquier alerta previa de 'contenedor_por_vencer'.
  // - Se inserta y emite la alerta 'retiro_solicitado' para notificar al operador en vivo con sonido y toast ("Listo en Rutas").
  // - Se notifica al cliente por WhatsApp que el retiro quedó programado.
  try {
    const vencidosSinRetiro = await query<{
      numero: string;
      vence_en: string;
      cliente_telefono: string | null;
      cliente_nombre: string | null;
      zona: string | null;
      destino_direccion: string | null;
      destino_lat: number | null;
      destino_lng: number | null;
    }>(
      `SELECT c.numero, to_char(c.vence_en, 'DD/MM HH24:MI') AS vence_en,
              ultima.cliente_telefono, ultima.zona, ultima.destino_direccion,
              ultima.destino_lat, ultima.destino_lng,
              cl.nombre AS cliente_nombre
         FROM contenedores c
         LEFT JOIN LATERAL (
           SELECT v.cliente_telefono, v.zona, v.destino_direccion, v.destino_lat, v.destino_lng
             FROM viajes v
            WHERE v.contenedor_numero = c.numero AND v.tipo = 'entrega' AND v.estado <> 'cancelado'
            ORDER BY v.creado_en DESC LIMIT 1
         ) ultima ON true
         LEFT JOIN clientes cl ON cl.telefono = ultima.cliente_telefono
        WHERE c.estado = 'entregado'
          AND c.vence_en IS NOT NULL
          AND c.vence_en < now()
          -- Evita duplicar si ya existe un retiro activo (programado o en curso):
          AND NOT EXISTS (
            SELECT 1 FROM viajes v2
             WHERE v2.contenedor_numero = c.numero
               AND v2.tipo = 'retiro'
               AND v2.estado IN ('programado', 'en_curso')
          )`,
    );

    if (vencidosSinRetiro.length > 0) {
      const dias = proximosDiasHabiles(1);
      const fechaRetiro = dias[0]?.fecha ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const fechaRetiroEtiqueta = dias[0]?.etiqueta ?? fechaRetiro;
      const vaciadero = await resolverUbicacion('vaciadero');

      for (const cv of vencidosSinRetiro) {
        // 1) Crear el viaje de retiro en la tabla viajes (ruta_id = null -> entra directo a la Bolsa de Rutas)
        await query(
          `INSERT INTO viajes (
             tipo, fecha, contenedor_numero, cliente_telefono,
             zona, destino_direccion, destino_lat, destino_lng,
             notas, ubicacion_id, ubicacion_direccion
           ) VALUES (
             'retiro', $1, $2, $3,
             $4, $5, $6, $7,
             'Retiro automático por vencimiento de plazo', $8, $9
           )`,
          [
            fechaRetiro,
            cv.numero,
            cv.cliente_telefono,
            cv.zona,
            cv.destino_direccion,
            cv.destino_lat,
            cv.destino_lng,
            vaciadero?.id ?? null,
            vaciadero?.direccion ?? null,
          ],
        );

        // 2) Resolver alerta previa de "contenedor_por_vencer" si existía
        await query(
          `UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'contenedor_por_vencer' AND referencia_id = $1`,
          [cv.numero],
        );
        emitAlertaActualizada({ tipo: 'contenedor_por_vencer', referencia_id: cv.numero, estado: 'resuelta' });

        // 3) Insertar alerta 'retiro_solicitado' para notificar al operador en vivo
        const mensajeAlerta = `Contenedor ${cv.numero} YA VENCIÓ — Ticket de retiro creado para el ${fechaRetiroEtiqueta} (Listo en Rutas)`;
        const [alertaRetiro] = await query<{ id: string; tipo: string; referencia_id: string; mensaje: string; creado_en: string }>(
          `INSERT INTO alertas (tipo, referencia_id, mensaje)
           VALUES ('retiro_solicitado', $1, $2)
           ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta'
             DO UPDATE SET mensaje = EXCLUDED.mensaje, estado = 'nueva'
           RETURNING id, tipo, referencia_id, mensaje, creado_en`,
          [cv.numero, mensajeAlerta],
        );

        if (alertaRetiro) {
          emitAlerta({ ...alertaRetiro, cliente_telefono: cv.cliente_telefono });
        }

        // 4) Aviso de cortesía al cliente por WhatsApp
        if (cv.cliente_telefono) {
          const nombre = cv.cliente_nombre && cv.cliente_nombre !== 'Sin nombre' ? ` ${cv.cliente_nombre}` : '';
          const cuerpoWa =
            `Hola${nombre} 👋 Te informamos que el plazo de alquiler del contenedor *${cv.numero}* ha finalizado.\n\n` +
            `Programamos su retiro para el *${formatearFechaLarga(fechaRetiro)}*.\n` +
            `Si aún lo estás utilizando o necesitás coordinar una extensión de días, respondé este mensaje o escribí *asesor*.`;

          sendText(cv.cliente_telefono, cuerpoWa).catch((e) =>
            console.error(`[cron] Error enviando aviso de retiro programado a ${cv.cliente_telefono}:`, e.message),
          );

          await query(
            `INSERT INTO mensajes_chat (telefono, origen, texto) VALUES ($1, 'bot', $2)`,
            [cv.cliente_telefono, cuerpoWa],
          ).catch(() => { });
        }
      }

      // 5) Notificar actualización de viajes y contenedores a las pantallas del panel
      emitRecursoActualizado('viajes');
      emitRecursoActualizado('contenedores');
      console.log(`[cron] ${vencidosSinRetiro.length} retiros automáticos creados por vencimiento`);
    }
  } catch (err: any) {
    console.error('[cron] Error procesando retiros automáticos por vencimiento:', err.message);
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
