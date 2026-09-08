import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth } from '../../middleware/rbac';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/** GET /api/dashboard/kpis — métricas para las tarjetas del panel. */
dashboardRouter.get('/kpis', async (_req: Request, res: Response) => {
  const [kpis] = await query<{
    contenedores_activos: number;
    contenedores_disponibles: number;
    cobros_pendientes: number;
    cobros_pendientes_monto: string;
    viajes_hoy: number;
  }>(
    `SELECT
       -- Ya no existe "en_camino": una entrega pasa directo de 'reservado' a
       -- 'entregado' (ver migración 0019_eliminar_en_camino.sql), así que
       -- 'reservado' ya representa "asignado, todavía no entregado".
       (SELECT count(*) FROM contenedores WHERE estado = 'reservado')::int               AS contenedores_activos,
       (SELECT count(*) FROM contenedores WHERE estado = 'disponible')::int              AS contenedores_disponibles,
       (SELECT count(*) FROM pagos WHERE estado = 'pendiente'
                                       OR (medio_pago = 'efectivo' AND estado = 'validado' AND efectivo_cobrado = FALSE))::int
                                                                                          AS cobros_pendientes,
       -- Incluye pagos pendientes de validación + efectivo validado pero aún
       -- no cobrado por el chofer. El monto puede faltar si todavía no se
       -- cargó (se asigna al validar, ver pagos.routes.ts).
       (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE estado = 'pendiente'
                                       OR (medio_pago = 'efectivo' AND estado = 'validado' AND efectivo_cobrado = FALSE))
                                                                                          AS cobros_pendientes_monto,
       -- Antes contaba historial_contenedores con estado='entregado' creado
       -- hoy: eso son confirmaciones de entrega, no "viajes de hoy" — excluía
       -- todos los retiros y no tenía relación con viajes.fecha (la fecha
       -- programada que usan Rutas/Viajes para todo lo demás).
       (SELECT count(*) FROM viajes WHERE fecha = current_date AND estado <> 'cancelado')::int AS viajes_hoy`,
  );
  res.json(kpis);
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
 * (cambios de estado de contenedores por choferes/admins, y pagos enviados/validados).
 */
dashboardRouter.get('/actividad', async (_req: Request, res: Response) => {
  const rows = await query<{
    tipo: string;
    entidad_id: string;
    accion: string;
    actor: string;
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
       h.creado_en AS fecha,
       h.nota AS detalle
     FROM historial_contenedores h
     UNION ALL
     SELECT
       'pago' AS tipo,
       p.id::text AS entidad_id,
       p.estado::text AS accion,
       'Cliente/Admin' AS actor,
       p.creado_en AS fecha,
       p.monto::text AS detalle
     FROM pagos p
     ORDER BY fecha DESC
     LIMIT 10`
  );
  res.json(rows);
});
