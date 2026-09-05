import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { clearSesion } from '../whatsapp/session.store';
import { emitAlertaActualizada, emitConversacionActualizada } from '../../config/socket';

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
         c.nombre AS cliente_nombre,
         p.monto,
         p.estado AS pago_estado,
         p.medio_pago,
         (p.url_comprobante IS NOT NULL) AS tiene_comprobante,
         pe.zona,
         pe.precio
    FROM alertas a
    LEFT JOIN pagos p    ON a.tipo IN ('pago_pendiente_validacion', 'alargue_solicitado', 'cuenta_corriente_solicitada') AND p.id::text = a.referencia_id
    LEFT JOIN pedidos pe ON pe.id = p.pedido_id
    LEFT JOIN clientes c ON c.telefono = p.cliente_telefono
`;
alertasRouter.get('/', async (req: Request, res: Response) => {
  const estado = req.query.estado as string | undefined;
  const rows = estado
    ? await query(`${SELECT_ALERTAS} WHERE a.estado = $1 ORDER BY a.creado_en DESC`, [estado])
    : await query(`${SELECT_ALERTAS} WHERE a.estado <> 'resuelta' ORDER BY a.creado_en DESC`);
  res.json(rows);
});

/** PATCH /api/alertas/:id — cambia estado (vista/resuelta). Solo roles que pueden operar sobre lo que la alerta representa (pago, asesoría, etc.), no lectura. */
alertasRouter.patch('/:id', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const estado = req.body?.estado as string;
  if (!['nueva', 'vista', 'resuelta'].includes(estado))
    return res.status(400).json({ error: 'Estado inválido' });
  const [row] = await query('UPDATE alertas SET estado = $1 WHERE id = $2 RETURNING *', [estado, req.params.id]);

  // Al resolver un pedido de asesor, le devolvemos el control al bot
  // (borra la sesión: modoHumano, flujo/paso quedan limpios de nuevo).
  if (row && row.tipo === 'solicita_asesor' && estado === 'resuelta') {
    await clearSesion(row.referencia_id).catch((e) => console.error('Error liberando sesión:', e));
    emitConversacionActualizada({ telefono: row.referencia_id, modo_humano: false });
  }
  if (row) emitAlertaActualizada({ tipo: row.tipo, referencia_id: row.referencia_id, estado: row.estado });

  res.json(row);
});
