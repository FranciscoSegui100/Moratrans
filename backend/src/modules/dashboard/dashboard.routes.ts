import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth } from '../../middleware/rbac';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/**
 * GET /api/dashboard/kpis — métricas para las tarjetas del panel.
 *
 * `contenedores_activos` contaba estado='reservado' (asignado, todavía no
 * entregado) — un estado transitorio que dura minutos u horas. Lo que un
 * gerente entiende por "contenedores activos" son los que están AHORA con
 * un cliente, o sea estado='entregado' — por eso el KPI daba 0 (o casi)
 * aunque hubiera varios contenedores realmente en la calle. 'reservado' se
 * expone aparte (contenedores_reservados) en vez de perderlo.
 */
dashboardRouter.get('/kpis', async (_req: Request, res: Response) => {
  const [kpis] = await query<{
    contenedores_activos: number;
    contenedores_reservados: number;
    contenedores_disponibles: number;
    cobros_pendientes: number;
    cobros_pendientes_monto: string;
    cobros_vencidos: number;
    viajes_hoy: number;
    viajes_ayer: number;
    entregas_hoy: number;
    alertas_activas: number;
    deuda_total: string;
    clientes_con_deuda: number;
  }>(
    // deuda_por_cliente: mismo cálculo por cliente que GET /api/clientes
    // (mantener en sync) — acá se reutiliza en un CTE para poder sumarlo
    // (deuda_total) y contar cuántos clientes tienen algo pendiente
    // (clientes_con_deuda) sin repetir la subconsulta dos veces.
    `WITH deuda_por_cliente AS (
       SELECT cl.id,
              GREATEST(COALESCE(cc.saldo, 0), 0) + COALESCE(oc.deuda, 0) AS deuda
         FROM clientes cl
         LEFT JOIN LATERAL (
           SELECT
             COALESCE((
               SELECT SUM(monto) FROM (
                 SELECT pe.precio AS monto FROM pedidos pe
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
     )
     SELECT
       (SELECT count(*) FROM contenedores WHERE estado = 'entregado')::int                AS contenedores_activos,
       (SELECT count(*) FROM contenedores WHERE estado = 'reservado')::int                AS contenedores_reservados,
       (SELECT count(*) FROM contenedores WHERE estado = 'disponible')::int               AS contenedores_disponibles,
       (SELECT count(*) FROM pagos WHERE estado = 'pendiente'
                                       OR (medio_pago = 'efectivo' AND estado = 'validado' AND efectivo_cobrado = FALSE))::int
                                                                                           AS cobros_pendientes,
       -- Incluye pagos pendientes de validación + efectivo validado pero aún
       -- no cobrado por el chofer. pagos.monto solo se carga para
       -- alargues/abonos — un flete normal nace sin monto propio y el precio
       -- vive en pedidos.precio (mismo criterio que ya usan GET /api/clientes
       -- y el aviso de cobro en efectivo al chofer, ver medioPagoDeViaje en
       -- viajes.routes.ts). Sin este COALESCE, la suma daba prácticamente $0
       -- aunque hubiera varios cobros pendientes reales.
       (SELECT COALESCE(SUM(COALESCE(p.monto, pe.precio)), 0)
          FROM pagos p LEFT JOIN pedidos pe ON pe.id = p.pedido_id
         WHERE p.estado = 'pendiente'
            OR (p.medio_pago = 'efectivo' AND p.estado = 'validado' AND p.efectivo_cobrado = FALSE))
                                                                                           AS cobros_pendientes_monto,
       -- Mismo criterio que el cron de alertas (alertas.cron.ts): pagos
       -- pendientes hace más de 24h.
       (SELECT count(*) FROM pagos WHERE estado = 'pendiente' AND creado_en < now() - interval '24 hours')::int
                                                                                           AS cobros_vencidos,
       -- Antes contaba historial_contenedores con estado='entregado' creado
       -- hoy: eso son confirmaciones de entrega, no "viajes de hoy" — excluía
       -- todos los retiros y no tenía relación con viajes.fecha (la fecha
       -- programada que usan Rutas/Viajes para todo lo demás).
       (SELECT count(*) FROM viajes WHERE fecha = current_date AND estado <> 'cancelado')::int             AS viajes_hoy,
       (SELECT count(*) FROM viajes WHERE fecha = current_date - 1 AND estado <> 'cancelado')::int         AS viajes_ayer,
       (SELECT count(*) FROM historial_contenedores WHERE estado = 'entregado' AND creado_en::date = current_date)::int
                                                                                           AS entregas_hoy,
       (SELECT count(*) FROM alertas WHERE estado <> 'resuelta')::int                     AS alertas_activas,
       (SELECT COALESCE(SUM(deuda), 0) FROM deuda_por_cliente)                            AS deuda_total,
       (SELECT count(*) FROM deuda_por_cliente WHERE deuda > 0)::int                      AS clientes_con_deuda`,
  );
  res.json(kpis);
});

/**
 * GET /api/dashboard/tendencia — últimos 7 días de actividad real (para las
 * mini-gráficas de barras de los KPI, en vez de los valores de ejemplo
 * hardcodeados que había antes).
 */
dashboardRouter.get('/tendencia', async (_req: Request, res: Response) => {
  const rows = await query<{ fecha: string; viajes: number; entregas: number }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS fecha,
            (SELECT count(*) FROM viajes v WHERE v.fecha = d AND v.estado <> 'cancelado')::int AS viajes,
            (SELECT count(*) FROM historial_contenedores h WHERE h.estado = 'entregado' AND h.creado_en::date = d)::int AS entregas
       FROM generate_series(current_date - interval '6 days', current_date, interval '1 day') d
      ORDER BY d`,
  );
  res.json(rows);
});

/** GET /api/dashboard/contenedores — distribución por estado (para gráfico). */
dashboardRouter.get('/contenedores', async (_req: Request, res: Response) => {
  const rows = await query('SELECT estado, count(*)::int AS total FROM contenedores GROUP BY estado');
  res.json(rows);
});

/**
 * GET /api/dashboard/comprobantes — histórico de comprobantes de pago ya
 * enviados por el cliente (cualquier estado: pendiente/validado/rechazado),
 * más recientes primero. El binario del comprobante en sí se sigue sirviendo
 * por GET /api/pagos/:id/comprobante (mismo criterio de rol admin/operador/finanzas).
 */
dashboardRouter.get('/comprobantes', async (_req: Request, res: Response) => {
  const rows = await query<{
    id: string;
    cliente_telefono: string;
    cliente_nombre: string | null;
    monto: string | null;
    estado: string;
    tipo: string;
    creado_en: string;
    titular_transferencia: string | null;
    zona: string | null;
    precio: string | null;
  }>(
    `SELECT p.id, p.cliente_telefono, COALESCE(c.nombre, pe.cliente_nombre) AS cliente_nombre,
            p.monto, p.estado, p.tipo, p.creado_en, p.titular_transferencia,
            pe.zona, pe.precio
       FROM pagos p
       LEFT JOIN pedidos pe ON pe.id = p.pedido_id
       LEFT JOIN clientes c ON c.telefono = p.cliente_telefono
      WHERE p.url_comprobante IS NOT NULL
      ORDER BY p.creado_en DESC
      LIMIT 200`,
  );
  res.json(rows);
});

/**
 * GET /api/dashboard/actividad — feed combinado de actividad reciente
 * (cambios de estado de contenedores por choferes/admins, y pagos
 * enviados/validados). Antes el lado de "pago" mostraba el UUID del pago
 * como entidad_id y 'Cliente/Admin' fijo como actor — ninguno de los dos
 * decía nada útil. Ahora entidad_id queda null para pagos (no aplica) y
 * actor es el nombre real del cliente, con el medio de pago + monto en
 * detalle.
 */
dashboardRouter.get('/actividad', async (_req: Request, res: Response) => {
  const rows = await query<{
    tipo: string;
    entidad_id: string | null;
    accion: string;
    actor: string;
    cliente_telefono: string | null;
    fecha: string;
    detalle: string | null;
  }>(
    `SELECT
       'contenedor' AS tipo,
       h.numero_contenedor AS entidad_id,
       h.estado::text AS accion,
       COALESCE(
         CASE
           WHEN h.actualizado_por LIKE 'chofer:%' THEN (SELECT nombre FROM choferes WHERE id = (split_part(h.actualizado_por, ':', 2))::uuid)
           WHEN h.actualizado_por LIKE 'operador:%' THEN (SELECT nombre FROM usuarios WHERE id = (split_part(h.actualizado_por, ':', 2))::uuid)
           WHEN h.actualizado_por LIKE 'admin:%' THEN (SELECT nombre FROM usuarios WHERE id = (split_part(h.actualizado_por, ':', 2))::uuid)
           ELSE h.actualizado_por
         END,
         'Sistema'
       ) AS actor,
       NULL AS cliente_telefono,
       h.creado_en AS fecha,
       h.nota AS detalle
     FROM historial_contenedores h
     UNION ALL
     SELECT
       'pago' AS tipo,
       NULL AS entidad_id,
       p.estado::text AS accion,
       COALESCE(c.nombre, p.cliente_telefono) AS actor,
       p.cliente_telefono AS cliente_telefono,
       p.creado_en AS fecha,
       (CASE WHEN p.medio_pago = 'efectivo' THEN 'Efectivo' WHEN p.medio_pago = 'transferencia' THEN 'Transferencia' ELSE 'Cuenta corriente' END)
         || COALESCE('  ·  $' || trim(to_char(COALESCE(p.monto, pe.precio), 'FM999G999G999')), '') AS detalle
       FROM pagos p
       LEFT JOIN pedidos pe ON pe.id = p.pedido_id
       LEFT JOIN clientes c ON c.telefono = p.cliente_telefono
     ORDER BY fecha DESC
     LIMIT 12`
  );
  res.json(rows);
});
