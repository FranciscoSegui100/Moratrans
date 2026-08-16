import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { excelClientes } from '../reportes/reportes.service';

export const clientesRouter = Router();
clientesRouter.use(requireAuth);

/** GET /api/clientes — listado con totales de viajes (join por teléfono, ver clientes.service.ts). */
clientesRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT cl.id, cl.nombre, cl.telefono, cl.cuenta_corriente_estado, cl.creado_en,
            COUNT(v.id)::int AS cantidad_viajes, MAX(v.fecha) AS ultimo_viaje
       FROM clientes cl
       LEFT JOIN viajes v ON v.cliente_telefono = cl.telefono
      GROUP BY cl.id
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
  const buf = await excelClientes(mes);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="clientes.xlsx"');
  res.send(buf);
});

/** GET /api/clientes/:telefono/viajes?mes=YYYY-MM — detalle de viajes de un cliente. */
clientesRouter.get('/:telefono/viajes', async (req: Request, res: Response) => {
  const mes = (req.query.mes as string) || null;
  const rows = await query(
    `SELECT v.id, v.tipo, v.fecha, v.estado, v.zona, v.contenedor_numero, v.destino_direccion, v.patente,
            ch.nombre AS chofer_nombre
       FROM viajes v
       LEFT JOIN choferes ch ON ch.id = v.chofer_id
      WHERE v.cliente_telefono = $1
        AND ($2::text IS NULL OR to_char(v.fecha, 'YYYY-MM') = $2)
      ORDER BY v.fecha DESC`,
    [req.params.telefono, mes],
  );
  res.json(rows);
});

const patchSchema = z.object({
  cuenta_corriente_estado: z.enum(['sin_pedir', 'pendiente', 'aprobada', 'rechazada']),
});

/** PATCH /api/clientes/:id — aprobar/rechazar cuenta corriente a mano desde el panel. */
clientesRouter.patch('/:id', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const [row] = await query(
    `UPDATE clientes SET cuenta_corriente_estado = $1 WHERE id = $2
     RETURNING id, nombre, telefono, cuenta_corriente_estado`,
    [parsed.data.cuenta_corriente_estado, req.params.id],
  );
  if (!row) return res.status(404).json({ error: 'Cliente inexistente' });
  res.json(row);
});
