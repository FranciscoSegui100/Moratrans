import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth } from '../../middleware/rbac';
import { clearSesion } from '../whatsapp/session.store';

export const alertasRouter = Router();
alertasRouter.use(requireAuth);

/**
 * GET /api/alertas?estado=nueva
 * Para alertas de tipo 'pago_pendiente_validacion' se suman los datos del pago
 * (y del pedido asociado) para poder mostrar el comprobante y decidir
 * validar/rechazar directamente desde la bandeja de alertas.
 */
const SELECT_ALERTAS = `
  SELECT a.*,
         p.cliente_telefono,
         p.monto,
         p.estado AS pago_estado,
         (p.url_comprobante IS NOT NULL) AS tiene_comprobante,
         pe.zona,
         pe.precio,
         td.moneda
    FROM alertas a
    LEFT JOIN pagos p    ON a.tipo = 'pago_pendiente_validacion' AND p.id::text = a.referencia_id
    LEFT JOIN pedidos pe ON pe.id = p.pedido_id
    LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
`;
alertasRouter.get('/', async (req: Request, res: Response) => {
  const estado = req.query.estado as string | undefined;
  const rows = estado
    ? await query(`${SELECT_ALERTAS} WHERE a.estado = $1 ORDER BY a.creado_en DESC`, [estado])
    : await query(`${SELECT_ALERTAS} WHERE a.estado <> 'resuelta' ORDER BY a.creado_en DESC`);
  res.json(rows);
});

/** PATCH /api/alertas/:id — cambia estado (vista/resuelta). */
alertasRouter.patch('/:id', async (req: Request, res: Response) => {
  const estado = req.body?.estado as string;
  if (!['nueva', 'vista', 'resuelta'].includes(estado))
    return res.status(400).json({ error: 'Estado inválido' });
  const [row] = await query('UPDATE alertas SET estado = $1 WHERE id = $2 RETURNING *', [estado, req.params.id]);

  // Al resolver un pedido de asesor, le devolvemos el control al bot
  // (borra la sesión: modoHumano, flujo/paso quedan limpios de nuevo).
  if (row && row.tipo === 'solicita_asesor' && estado === 'resuelta') {
    await clearSesion(row.referencia_id).catch((e) => console.error('Error liberando sesión:', e));
  }

  res.json(row);
});
