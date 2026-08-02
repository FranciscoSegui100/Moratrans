import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth } from '../../middleware/rbac';
import { excelContenedores, pdfResumenPagos } from './reportes.service';

export const reportesRouter = Router();
reportesRouter.use(requireAuth);

/** GET /api/reportes/contenedores.xlsx */
reportesRouter.get('/contenedores.xlsx', async (_req: Request, res: Response) => {
  const buf = await excelContenedores();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="contenedores.xlsx"');
  res.send(buf);
});

/** GET /api/reportes/pagos.pdf — respeta el mismo criterio de acceso del panel. */
reportesRouter.get('/pagos.pdf', async (req: Request, res: Response) => {
  // El reporte no incluye la URL del comprobante; solo metadatos del pago.
  const pagos = await query(
    'SELECT cliente_telefono, estado, monto, creado_en FROM pagos ORDER BY creado_en DESC LIMIT 500',
  );
  const buf = await pdfResumenPagos(pagos as any);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="pagos.pdf"');
  res.send(buf);
});
