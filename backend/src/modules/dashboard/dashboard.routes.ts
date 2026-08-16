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
    viajes_hoy: number;
  }>(
    `SELECT
       -- Ya no existe "en_camino": una entrega pasa directo de 'reservado' a
       -- 'entregado' (ver migración 0019_eliminar_en_camino.sql), así que
       -- 'reservado' ya representa "asignado, todavía no entregado".
       (SELECT count(*) FROM contenedores WHERE estado = 'reservado')::int               AS contenedores_activos,
       (SELECT count(*) FROM contenedores WHERE estado = 'disponible')::int              AS contenedores_disponibles,
       (SELECT count(*) FROM pagos WHERE estado = 'pendiente')::int                       AS cobros_pendientes,
       (SELECT count(*) FROM historial_contenedores
          WHERE estado = 'entregado' AND creado_en::date = current_date)::int             AS viajes_hoy`,
  );
  res.json(kpis);
});

/** GET /api/dashboard/contenedores — distribución por estado (para gráfico). */
dashboardRouter.get('/contenedores', async (_req: Request, res: Response) => {
  const rows = await query('SELECT estado, count(*)::int AS total FROM contenedores GROUP BY estado');
  res.json(rows);
});
