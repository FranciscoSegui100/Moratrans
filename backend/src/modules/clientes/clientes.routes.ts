import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { excelClientes, enviarExcelClientePorWhatsApp, enviarResumenCuentaCorrientePorWhatsApp, resumenCuentaCorriente } from '../reportes/reportes.service';
import { motivoErrorWa } from '../whatsapp/graphApi';
import { normalizarTelefonoAR } from '../../services/telefono.service';

export const clientesRouter = Router();
clientesRouter.use(requireAuth);

/**
 * GET /api/clientes — listado con totales de viajes (join por teléfono, ver
 * clientes.service.ts). Suma el pago en efectivo más reciente que todavía no
 * se marcó cobrado (si tiene alguno) para poder mostrar/tildar "Pagado" de
 * un vistazo en la tabla, sin tener que entrar al perfil de cada cliente
 * (ver migración 0043 y PATCH /api/pagos/:id/cobrado).
 */
clientesRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT cl.id, cl.nombre, cl.telefono, cl.cuenta_corriente_estado, cl.numero_plan, cl.creado_en,
            COUNT(v.id)::int AS cantidad_viajes, MAX(v.fecha) AS ultimo_viaje,
            ep.id AS efectivo_pendiente_id, ep.monto AS efectivo_pendiente_monto
       FROM clientes cl
       LEFT JOIN viajes v ON v.cliente_telefono = cl.telefono
       LEFT JOIN LATERAL (
         SELECT p.id, COALESCE(p.monto, pe.precio) AS monto
           FROM pagos p
           LEFT JOIN pedidos pe ON pe.id = p.pedido_id
          WHERE p.cliente_telefono = cl.telefono AND p.medio_pago = 'efectivo' AND p.efectivo_cobrado = FALSE
          ORDER BY p.creado_en DESC LIMIT 1
       ) ep ON true
      GROUP BY cl.id, ep.id, ep.monto
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
            v.destino_lat, v.destino_lng, v.patente,
            v.remito, v.importe, v.grupo_id, ch.nombre AS chofer_nombre,
            v.es_cuenta_corriente,
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
