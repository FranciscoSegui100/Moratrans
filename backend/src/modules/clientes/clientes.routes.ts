import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { excelClientes, enviarExcelClientePorWhatsApp, enviarResumenCuentaCorrientePorWhatsApp, resumenCuentaCorriente, deudaCliente, enviarDeudaClientePorWhatsApp } from '../reportes/reportes.service';
import { sendText, motivoErrorWa } from '../whatsapp/graphApi';
import { datosBancarios } from '../whatsapp/flows/pago.flow';
import { notificarEnvioFallido } from '../whatsapp/alertaEnvio';
import { emitAlerta, emitRecursoActualizado } from '../../config/socket';
import { encrypt, encryptBuffer } from '../../services/crypto.service';
import { subirArchivo } from '../../services/storage.service';
import { normalizarTelefonoAR } from '../../services/telefono.service';

export const clientesRouter = Router();
clientesRouter.use(requireAuth);

/**
 * GET /api/clientes — listado con totales de viajes (join por teléfono, ver
 * clientes.service.ts) y un único número de "deuda" por cliente para poder
 * mostrarlo de un vistazo en la tabla, sin entrar al perfil de cada uno.
 *
 * Sale de sumar DOS cálculos independientes, sin importar el
 * cuenta_corriente_estado ACTUAL del cliente:
 *  - cc.saldo: cargos - abonos de cuenta corriente (mismo criterio que
 *    resumenCuentaCorriente() en reportes.service.ts).
 *  - oc.deuda: pedidos ocasionales sin pagar (mismo criterio que
 *    itemsDeuda() en reportes.service.ts — mantener en sync si cambia la
 *    definición de "pagado").
 * Por qué sumar y no elegir uno según el estado actual: el flag
 * es_cuenta_corriente queda grabado en cada pago/viaje al momento de
 * crearse y no se toca si después el cliente pasa de cuenta corriente a
 * ocasional (o viceversa) — así que un cliente puede tener las dos deudas
 * a la vez. Elegir una sola según el estado actual hacía que la otra
 * desapareciera de la vista apenas se cambiaba el tipo de cliente, aunque
 * la plata siguiera sin cobrarse. GREATEST(...,0) evita que un saldo a
 * favor (cliente que pagó de más su cuenta corriente) tape una deuda
 * ocasional real.
 */
clientesRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT cl.id, cl.nombre, cl.telefono, cl.cuenta_corriente_estado, cl.numero_plan, cl.creado_en,
            COUNT(v.id)::int AS cantidad_viajes,
            GREATEST(COALESCE(cc.saldo, 0), 0) + COALESCE(oc.deuda, 0) AS deuda
       FROM clientes cl
       LEFT JOIN viajes v ON v.cliente_telefono = cl.telefono
       LEFT JOIN LATERAL (
         SELECT
           COALESCE((
             SELECT SUM(monto) FROM (
               SELECT pe.precio AS monto
                 FROM pedidos pe
                WHERE pe.cliente_telefono = cl.telefono
                  AND EXISTS (SELECT 1 FROM pagos pg WHERE pg.pedido_id = pe.id AND pg.es_cuenta_corriente = TRUE)
               UNION ALL
               SELECT v2.importe AS monto FROM viajes v2
                WHERE v2.cliente_telefono = cl.telefono AND v2.es_cuenta_corriente = TRUE
               UNION ALL
               SELECT pg2.monto FROM pagos pg2
                WHERE pg2.cliente_telefono = cl.telefono AND pg2.tipo = 'alargue_retiro' AND pg2.es_cuenta_corriente = TRUE
             ) cargos
           ), 0)
           -
           COALESCE((
             SELECT SUM(monto) FROM pagos
              WHERE cliente_telefono = cl.telefono AND tipo = 'abono_cc' AND estado = 'validado'
           ), 0) AS saldo
       ) cc ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(monto), 0) AS deuda FROM (
           SELECT v3.importe AS monto
             FROM viajes v3
             LEFT JOIN pagos pg3 ON pg3.id = v3.pago_id
            WHERE v3.cliente_telefono = cl.telefono
              AND NOT (v3.tipo = 'retiro' AND v3.grupo_id IS NULL)
              AND v3.es_cuenta_corriente = FALSE
              AND ((pg3.medio_pago = 'efectivo' AND pg3.efectivo_cobrado = FALSE)
                   OR (pg3.medio_pago = 'transferencia' AND pg3.estado <> 'validado'))
           UNION ALL
           SELECT pg4.monto
             FROM pagos pg4
            WHERE pg4.cliente_telefono = cl.telefono AND pg4.tipo = 'alargue_retiro' AND pg4.es_cuenta_corriente = FALSE
              AND ((pg4.medio_pago = 'efectivo' AND pg4.efectivo_cobrado = FALSE)
                   OR (pg4.medio_pago = 'transferencia' AND pg4.estado <> 'validado'))
         ) items
       ) oc ON true
      GROUP BY cl.id, cc.saldo, oc.deuda
      ORDER BY cl.nombre`,
  );
  res.json(rows);
});

/**
 * GET /api/clientes/export.xlsx?mes=YYYY-MM — declarada antes de
 * /:telefono/viajes solo por prolijidad (no colisionan: distinta cantidad de
 * segmentos), exporta todos los viajes de todos los clientes seccionados por
 * mes en hojas separadas (o un mes puntual si se pasa ?mes=).
 */
clientesRouter.get('/export.xlsx', async (req: Request, res: Response) => {
  const mes = (req.query.mes as string) || undefined;
  const telefono = (req.query.telefono as string) || undefined;
  const buf = await excelClientes(mes, telefono);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="clientes.xlsx"');
  res.send(buf);
});

/**
 * POST /api/clientes/:telefono/enviar-excel — genera el Excel de este
 * cliente (mismo formato que el botón de descarga) y se lo manda por
 * WhatsApp como documento.
 */
clientesRouter.post(
  '/:telefono/enviar-excel',
  requireRol('admin', 'operador', 'finanzas'),
  async (req: Request, res: Response) => {
    const telefono = req.params.telefono;
    try {
      await enviarExcelClientePorWhatsApp(telefono);
      res.json({ ok: true });
    } catch (e) {
      const motivo = motivoErrorWa(e);
      console.error('Error enviando Excel de cliente por WhatsApp:', motivo);
      res.status(502).json({ error: `No se pudo enviar por WhatsApp: ${motivo}` });
    }
  },
);

/**
 * POST /api/clientes/:telefono/enviar-resumen-cuenta — el mismo PDF
 * (colores/logo/saldo, ver pdfResumenCuentaCorriente) que el cliente puede
 * pedir él mismo por WhatsApp con "📊 Resumen de cuenta" (ver
 * movimientos.flow.ts), pero disparado por un operador desde el panel — para
 * cuando el cliente pregunta por su saldo y conviene mandárselo de una en
 * vez de decirle que lo pida él.
 */
clientesRouter.post(
  '/:telefono/enviar-resumen-cuenta',
  requireRol('admin', 'operador', 'finanzas'),
  async (req: Request, res: Response) => {
    const telefono = req.params.telefono;
    const [cliente] = await query<{ nombre: string }>('SELECT nombre FROM clientes WHERE telefono = $1', [telefono]);
    try {
      await enviarResumenCuentaCorrientePorWhatsApp(telefono, cliente?.nombre ?? null);
      res.json({ ok: true });
    } catch (e) {
      const motivo = motivoErrorWa(e);
      console.error('Error enviando resumen de cuenta por WhatsApp:', motivo);
      res.status(502).json({ error: `No se pudo enviar por WhatsApp: ${motivo}` });
    }
  },
);

/**
 * GET /api/clientes/:telefono/deuda — pedidos sin pagar de un cliente
 * OCASIONAL (ver reportes.service.ts::deudaCliente), para mostrar "Posee
 * deuda: Sí/No" en la ficha del cliente sin tener que abrir cada viaje.
 */
clientesRouter.get('/:telefono/deuda', async (req: Request, res: Response) => {
  const resumen = await deudaCliente(req.params.telefono);
  res.json(resumen);
});

const viajeManualSchema = z.object({
  tipo: z.enum(['entrega', 'recambio', 'alargue_retiro']),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
  // Recambio: el contenedor lleno que se retira (o el único, si no es recambio).
  contenedor_numero: z.string().trim().min(1, 'Falta el número de contenedor'),
  // Solo recambio: el vacío que se deja. Opcional (carga histórica: a veces no se sabe).
  contenedor_numero_entrega: z.string().trim().min(1).optional(),
  importe: z.coerce.number().positive('El importe tiene que ser mayor a 0'),
  medio_pago: z.enum(['efectivo', 'transferencia']),
  pagado: z.boolean(),
  // Solo si pagado=true y medio_pago='transferencia'.
  comprobante_base64: z.string().optional(),
  comprobante_content_type: z.string().optional(),
});

const TIPO_LABEL: Record<string, string> = { entrega: 'Entrega', recambio: 'Recambio', alargue_retiro: 'Extensión de retiro' };

/**
 * POST /api/clientes/:telefono/viaje-manual — carga a mano un viaje/recambio/
 * extensión de retiro que YA se hizo fuera del sistema (ej. un pedido por
 * teléfono que nunca pasó por el bot), para no perder el registro de fechas,
 * contenedores y cobros. A propósito NO toca el estado del contenedor en la
 * pestaña Contenedores — es solo el registro de plata/fechas del cliente.
 *
 * Reglas de plata (confirmadas con el dueño del negocio):
 *  - Pagado -> nunca se agrega como cargo de cuenta corriente (ya está
 *    saldado), sea o no el cliente de cuenta corriente. Efectivo no pide
 *    nada más; transferencia pide el comprobante, que se sube y cifra con
 *    el mismo criterio que los que llegan por WhatsApp (ver pago.flow.ts).
 *  - No pagado + cliente OCASIONAL -> el pago queda 'pendiente' como
 *    cualquiera del bot (aparece en Validar pagos/Alertas) y se le manda
 *    automático por WhatsApp la solicitud de pago (datos bancarios si es
 *    transferencia, recordatorio si es efectivo).
 *  - No pagado + cliente CUENTA CORRIENTE -> se agrega directo como cargo
 *    (es_cuenta_corriente=TRUE, 'validado') — mismo criterio que un alargue
 *    de retiro pedido por cuenta corriente (ver alargarRetiro.flow.ts): no
 *    hay nada que un operador tenga que aprobar, y no se le manda nada al
 *    cliente porque la cuenta corriente se cobra junta, no pedido a pedido.
 */
clientesRouter.post('/:telefono/viaje-manual', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const parsed = viajeManualSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
  const v = parsed.data;
  const telefono = req.params.telefono;

  const [cliente] = await query<{ id: string; nombre: string; cuenta_corriente_estado: string }>(
    'SELECT id, nombre, cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [telefono],
  );
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const esCC = cliente.cuenta_corriente_estado === 'aprobada' || cliente.cuenta_corriente_estado === 'pendiente';
  const cargoCC = esCC && !v.pagado;

  let urlComprobanteCifrada: string | null = null;
  if (v.pagado && v.medio_pago === 'transferencia' && v.comprobante_base64) {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(v.comprobante_base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'Comprobante inválido' });
    }
    if (buffer.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'El comprobante no puede pesar más de 8MB' });
    const mime = v.comprobante_content_type || 'image/jpeg';
    const ext = mime.includes('pdf') ? 'pdf' : mime.split('/')[1] || 'jpg';
    const rutaStorage = `comprobantes/manual_${telefono}_${Date.now()}.${ext}`;
    try {
      // Mismo criterio que un comprobante que llega por WhatsApp: el binario
      // se cifra ANTES de subirlo (ver pago.flow.ts), y solo la referencia
      // cifrada queda en pagos.url_comprobante.
      await subirArchivo(encryptBuffer(buffer), rutaStorage, 'application/octet-stream');
    } catch (e) {
      console.error('Error subiendo comprobante manual:', e);
      return res.status(502).json({ error: 'No se pudo guardar el comprobante' });
    }
    urlComprobanteCifrada = encrypt(rutaStorage);
  }

  /** Solicitud de pago por WhatsApp de un viaje ya realizado (solo cliente ocasional, no pagado). */
  async function pedirPagoPorWhatsApp(): Promise<void> {
    const montoTexto = `$${v.importe.toLocaleString('es-AR')}`;
    const cuerpo =
      `📋 Tenés un pago pendiente de *${montoTexto}* — ${TIPO_LABEL[v.tipo].toLowerCase()} del contenedor ${v.contenedor_numero} (${v.fecha}).\n\n` +
      (v.medio_pago === 'transferencia'
        ? `${datosBancarios()}\n\nCuando hagas la transferencia, mandanos la foto del comprobante por acá. 📎`
        : '💵 Coordiná con nosotros el pago en efectivo cuando puedas.');
    try {
      await sendText(telefono, cuerpo);
    } catch (e) {
      const motivo = motivoErrorWa(e);
      console.error('Error mandando solicitud de pago manual:', motivo);
      notificarEnvioFallido(telefono, telefono, 'solicitud de pago de un viaje cargado a mano', motivo).catch((e2) =>
        console.error('Error registrando alerta de envío fallido:', e2),
      );
    }
  }

  try {
    if (v.tipo === 'alargue_retiro') {
      // 'validado' (pagado, o cargo de cuenta corriente ya aplicado) refleja
      // la fecha real en que pasó (v.fecha); 'pendiente' (solicitud recién
      // mandada) arranca a envejecer desde hoy, no desde la fecha del viaje
      // — si no, un backfill viejo aparecería como "vencido" de entrada.
      const estadoPago = cargoCC || v.pagado ? 'validado' : 'pendiente';
      const creadoEn = estadoPago === 'validado' ? v.fecha : null;
      const [pago] = await query<{ id: string }>(
        `INSERT INTO pagos (cliente_telefono, tipo, contenedor_numero, monto, medio_pago, estado, efectivo_cobrado, es_cuenta_corriente, url_comprobante, creado_en)
         VALUES ($1, 'alargue_retiro', $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date + interval '12 hours', now()))
         RETURNING id`,
        [telefono, v.contenedor_numero, v.importe, v.medio_pago, estadoPago,
         v.pagado && v.medio_pago === 'efectivo', cargoCC, urlComprobanteCifrada, creadoEn],
      );

      if (!v.pagado && !esCC) {
        const [alerta] = await query(
          `INSERT INTO alertas (tipo, referencia_id, mensaje)
           VALUES ('pago_pendiente_validacion', $1, $2)
           ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
           RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
          [pago.id, `Extensión de retiro cargada a mano para ${telefono} — contenedor ${v.contenedor_numero}`],
        );
        if (alerta) {
          emitAlerta({
            ...alerta, cliente_telefono: telefono, monto: String(v.importe), pago_estado: 'pendiente',
            tiene_comprobante: false, medio_pago: v.medio_pago, zona: null, precio: null,
          });
        }
        await pedirPagoPorWhatsApp();
      }
      emitRecursoActualizado('pagos');
      return res.json({ ok: true, pago_id: pago.id });
    }

    // tipo 'entrega' o 'recambio': van a la tabla viajes. Se crean ya
    // 'completado' (a diferencia de un viaje real armado desde el panel,
    // que arranca 'programado' — acá el hecho ya pasó, no hay nada que
    // programar ni asignarle a un chofer).
    const resultado = await withTx(async (c) => {
      let pagoId: string | null = null;
      if (!cargoCC) {
        // Mismo criterio que en la rama de alargue: 'validado' toma la
        // fecha real del viaje, 'pendiente' arranca a envejecer desde hoy.
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO pagos (cliente_telefono, tipo, monto, medio_pago, estado, efectivo_cobrado, es_cuenta_corriente, url_comprobante, creado_en)
           VALUES ($1, 'flete', $2, $3, $4, $5, FALSE, $6, COALESCE($7::date + interval '12 hours', now()))
           RETURNING id`,
          [telefono, v.importe, v.medio_pago, v.pagado ? 'validado' : 'pendiente',
           v.pagado && v.medio_pago === 'efectivo', urlComprobanteCifrada, v.pagado ? v.fecha : null],
        );
        pagoId = rows[0].id;
      }

      if (v.tipo === 'recambio') {
        const grupoId = randomUUID();
        await c.query(
          `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, importe, estado, es_cuenta_corriente, pago_id, grupo_id, notas)
           VALUES ('retiro', $1, $2, $3, NULL, 'completado', $4, $5, $6, 'Cargado a mano desde el perfil del cliente')`,
          [v.fecha, v.contenedor_numero, telefono, cargoCC, pagoId, grupoId],
        );
        await c.query(
          `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, importe, estado, es_cuenta_corriente, pago_id, grupo_id, notas)
           VALUES ('entrega', $1, $2, $3, $4, 'completado', $5, $6, $7, 'Cargado a mano desde el perfil del cliente')`,
          [v.fecha, v.contenedor_numero_entrega ?? null, telefono, v.importe, cargoCC, pagoId, grupoId],
        );
      } else {
        await c.query(
          `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, importe, estado, es_cuenta_corriente, pago_id, notas)
           VALUES ('entrega', $1, $2, $3, $4, 'completado', $5, $6, 'Cargado a mano desde el perfil del cliente')`,
          [v.fecha, v.contenedor_numero, telefono, v.importe, cargoCC, pagoId],
        );
      }
      return { pagoId };
    });

    if (!v.pagado && !esCC && resultado.pagoId) {
      const [alerta] = await query(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('pago_pendiente_validacion', $1, $2)
         ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
         RETURNING id, tipo, referencia_id, mensaje, estado, creado_en`,
        [resultado.pagoId, `${TIPO_LABEL[v.tipo]} cargada a mano para ${telefono} — contenedor ${v.contenedor_numero}`],
      );
      if (alerta) {
        emitAlerta({
          ...alerta, cliente_telefono: telefono, monto: null, pago_estado: 'pendiente',
          tiene_comprobante: false, medio_pago: v.medio_pago, zona: null, precio: String(v.importe),
        });
      }
      await pedirPagoPorWhatsApp();
    }
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('pagos');
    res.json({ ok: true, pago_id: resultado.pagoId });
  } catch (e: any) {
    console.error('Error cargando viaje manual:', e);
    if (e.code === '23503') return res.status(400).json({ error: 'Ese número de contenedor no existe — cargalo primero en la pestaña Contenedores.' });
    res.status(500).json({ error: 'No se pudo cargar el viaje' });
  }
});

/**
 * POST /api/clientes/:telefono/enviar-resumen-deuda — a diferencia de
 * enviar-resumen-cuenta (pensado para cuenta corriente), esto es para un
 * cliente OCASIONAL: le manda solo sus pedidos sin pagar, no un historial
 * completo que no le corresponde ver. 409 si no tiene nada pendiente (ver
 * enviarDeudaClientePorWhatsApp) — no es un error de WhatsApp, así que no
 * pasa por motivoErrorWa.
 */
clientesRouter.post(
  '/:telefono/enviar-resumen-deuda',
  requireRol('admin', 'operador', 'finanzas'),
  async (req: Request, res: Response) => {
    const telefono = req.params.telefono;
    const [cliente] = await query<{ nombre: string }>('SELECT nombre FROM clientes WHERE telefono = $1', [telefono]);
    try {
      await enviarDeudaClientePorWhatsApp(telefono, cliente?.nombre ?? null);
      res.json({ ok: true });
    } catch (e: any) {
      if (e?.message === 'Este cliente no tiene pedidos pendientes de pago.') {
        return res.status(409).json({ error: e.message });
      }
      const motivo = motivoErrorWa(e);
      console.error('Error enviando resumen de deuda por WhatsApp:', motivo);
      res.status(502).json({ error: `No se pudo enviar por WhatsApp: ${motivo}` });
    }
  },
);

/**
 * GET /api/clientes/:telefono/cuenta-corriente — para la tarjeta de resumen
 * en ClienteDetalle: deuda acumulada, pagos ya acreditados y saldo neto (ver
 * reportes.service.ts::resumenCuentaCorriente). Solo tiene sentido para
 * clientes de cuenta corriente, pero no se restringe acá — un cliente
 * ocasional simplemente da todo en $0.
 */
clientesRouter.get('/:telefono/cuenta-corriente', async (req: Request, res: Response) => {
  const resumen = await resumenCuentaCorriente(req.params.telefono);
  res.json(resumen);
});

/** GET /api/clientes/:telefono/viajes?mes=YYYY-MM — detalle de viajes de un cliente. */
clientesRouter.get('/:telefono/viajes', async (req: Request, res: Response) => {
  const mes = (req.query.mes as string) || null;
  const rows = await query(
    `SELECT v.id, v.tipo, v.fecha, v.estado, v.zona, v.contenedor_numero, v.destino_direccion,
            v.destino_lat, v.destino_lng,
            v.remito, v.importe, v.grupo_id, ch.nombre AS chofer_nombre,
            v.es_cuenta_corriente, co.vence_en,
            -- Mismo criterio que GET /api/viajes (ver viajes.routes.ts): inicial
            -- vinculado por pago_id, extensiones de alargue_retiro del mismo
            -- contenedor+cliente creadas después de este viaje.
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', p.id,
                'tipo', p.tipo,
                'monto', p.monto,
                'estado', p.estado,
                'es_cuenta_corriente', p.es_cuenta_corriente,
                'tiene_comprobante', (p.url_comprobante IS NOT NULL),
                'titular', p.titular_transferencia,
                'medio_pago', p.medio_pago,
                'efectivo_cobrado', p.efectivo_cobrado,
                'creado_en', p.creado_en
              ) ORDER BY p.creado_en ASC)
              FROM pagos p
              WHERE (p.id = v.pago_id)
                 OR (p.tipo = 'alargue_retiro'
                     AND p.contenedor_numero = v.contenedor_numero
                     AND p.cliente_telefono = v.cliente_telefono
                     AND p.creado_en >= v.creado_en)
            ), '[]'::json) AS comprobantes
       FROM viajes v
       LEFT JOIN choferes ch ON ch.id = v.chofer_id
       LEFT JOIN contenedores co ON co.numero = v.contenedor_numero
      WHERE v.cliente_telefono = $1
        AND ($2::text IS NULL OR to_char(v.fecha, 'YYYY-MM') = $2)
      ORDER BY v.fecha DESC`,
    [req.params.telefono, mes],
  );
  res.json(rows);
});

const createSchema = z.object({
  nombre: z.string().trim().min(1, 'Falta el nombre'),
  telefono: z.string().trim().min(6, 'Falta el teléfono'),
  // El operador elige de entrada si lo está cargando como cliente de cuenta
  // corriente (ya conocido de antes del sistema) u ocasional (paga cada
  // viaje por transferencia) — a diferencia del que se crea solo al cotizar
  // por WhatsApp, que siempre arranca en 'sin_pedir'.
  cuenta_corriente_estado: z.enum(['sin_pedir', 'aprobada']),
});

/**
 * POST /api/clientes — alta manual de un cliente que todavía no cotizó por
 * WhatsApp (hoy la tabla sólo se llena sola cuando cotizan, ver GET /
 * vacío).
 */
clientesRouter.post('/', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
  const telefono = normalizarTelefonoAR(parsed.data.telefono);
  try {
    const [row] = await query(
      `INSERT INTO clientes (nombre, telefono, cuenta_corriente_estado)
       VALUES ($1, $2, $3)
       RETURNING id, nombre, telefono, cuenta_corriente_estado, numero_plan`,
      [parsed.data.nombre, telefono, parsed.data.cuenta_corriente_estado],
    );
    res.status(201).json(row);
  } catch (e: any) {
    if (e.code === '23505') { // Unique violation (telefono)
      res.status(409).json({ error: 'Ya existe un cliente con ese teléfono' });
    } else {
      console.error('Error al crear cliente:', e);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
});

const patchSchema = z.object({
  cuenta_corriente_estado: z.enum(['sin_pedir', 'pendiente', 'aprobada', 'rechazada']).optional(),
  // Numeración interna propia del cliente (viene de la planilla Excel que ya usaban).
  numero_plan: z.coerce.number().int().nullable().optional(),
});

/** PATCH /api/clientes/:id — aprobar/rechazar cuenta corriente o cargar el Nº de plan (admin/operador/finanzas). */
clientesRouter.patch('/:id', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, val] of Object.entries(parsed.data)) {
    params.push(val); sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
  params.push(req.params.id);
  try {
    const [row] = await query(
      `UPDATE clientes SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, nombre, telefono, cuenta_corriente_estado, numero_plan`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'Cliente inexistente' });
    res.json(row);
  } catch (e: any) {
    if (e.code === '23505') { // Unique violation
      res.status(409).json({ error: 'Ese número de plan ya está usado por otro cliente' });
    } else {
      console.error('Error al actualizar cliente:', e);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
});

/**
 * DELETE /api/clientes/:id — borrar un cliente ocasional cargado por error o
 * que no corresponde mantener (ej. un duplicado, un número de prueba). No
 * hay ON DELETE CASCADE desde viajes/pagos (se vinculan por teléfono, no por
 * FK a clientes.id) así que esto no borra ningún historial de viajes; sólo
 * contenedores.cliente_id se pone en NULL si tenía alguno asignado.
 *
 * Solo se permite si nunca pidió cuenta corriente (cuenta_corriente_estado =
 * 'sin_pedir') — borrar un cliente 'aprobada'/'pendiente'/'rechazada' haría
 * desaparecer silenciosamente ese estado: como viajes/pagos se vinculan por
 * teléfono y no por FK, el saldo/historial de deuda sigue existiendo pero
 * queda huérfano, y si el cliente vuelve a cotizar por WhatsApp se le crea
 * una fila nueva arrancando en 'sin_pedir', perdiendo la aprobación.
 */
clientesRouter.delete('/:id', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const [cliente] = await query<{ cuenta_corriente_estado: string }>(
    'SELECT cuenta_corriente_estado FROM clientes WHERE id = $1',
    [req.params.id],
  );
  if (!cliente) return res.status(404).json({ error: 'Cliente inexistente' });
  if (cliente.cuenta_corriente_estado !== 'sin_pedir') {
    return res.status(409).json({
      error: 'Este cliente tiene (o tuvo) cuenta corriente — no se puede eliminar para no perder ese historial. Solo se pueden borrar clientes ocasionales.',
    });
  }
  await query(`DELETE FROM clientes WHERE id = $1`, [req.params.id]);
  res.status(204).send();
});
