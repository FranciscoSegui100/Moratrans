import { Router, Request, Response } from 'express';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { resumenMensual, excelFinanzas } from './finanzas.service';

export const finanzasRouter = Router();
// Datos de facturación: mismo criterio de sensibilidad que Usuarios — solo
// admin/finanzas, ni siquiera operador (que sí puede validar pagos puntuales,
// pero un resumen agregado de ingresos es otra cosa).
finanzasRouter.use(requireAuth, requireRol('admin', 'finanzas'));

function anioDeQuery(req: Request): number {
  const anio = Number(req.query.anio);
  return Number.isInteger(anio) && anio >= 2000 && anio <= 2100 ? anio : new Date().getFullYear();
}

/** GET /api/finanzas/resumen?anio=YYYY — resumen mensual para el panel. */
finanzasRouter.get('/resumen', async (req: Request, res: Response) => {
  const data = await resumenMensual(anioDeQuery(req));
  res.json(data);
});

/** GET /api/finanzas/excel?anio=YYYY — descarga del Excel con el mismo resumen + detalle. */
finanzasRouter.get('/excel', async (req: Request, res: Response) => {
  const anio = anioDeQuery(req);
  const buf = await excelFinanzas(anio);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="moratrans-ingresos-${anio}.xlsx"`);
  res.send(buf);
});
