import { Router, Request, Response } from 'express';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { resolverAsesor } from '../whatsapp/flows/asesor.flow';
import { emitAlertaActualizada } from '../../config/socket';

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
         p.medio_pago,
         (p.url_comprobante IS NOT NULL) AS tiene_comprobante,
         pe.zona,
         pe.precio
    FROM alertas a
    LEFT JOIN pagos p    ON a.tipo IN ('pago_pendiente_validacion', 'alargue_solicitado') AND p.id::text = a.referencia_id
    LEFT JOIN pedidos pe ON pe.id = p.pedido_id
`;
alertasRouter.get('/', async (req: Request, res: Response) => {
  const estado = req.query.estado as string | undefined;
  const rows = estado
    ? await query(`${SELECT_ALERTAS} WHERE a.estado = $1 ORDER BY a.creado_en DESC`, [estado])
    : await query(`${SELECT_ALERTAS} WHERE a.estado <> 'resuelta' ORDER BY a.creado_en DESC`);
  res.json(rows);
});

/**
 * PATCH /api/alertas/marcar-vistas — el usuario entró a la bandeja: todas
 * las 'nueva' pasan a 'vista' en un solo UPDATE. Separa "¿la vio alguien?"
 * (el contador del sidebar, que ahora baja de verdad en la base y no solo
 * en memoria) de "¿está resuelta?" (sigue en la lista hasta resolverla).
 * Se avisa por socket con el mismo 'alerta_actualizada' que ya usa
 * 'resuelta', así otras pestañas/operadores lo ven en vivo. Va ANTES de
 * '/:id' para que Express no tome "marcar-vistas" como un id.
 */
alertasRouter.patch('/marcar-vistas', async (_req: Request, res: Response) => {
  const rows = await query<{ tipo: string; referencia_id: string; estado: string }>(
    `UPDATE alertas SET estado = 'vista' WHERE estado = 'nueva' RETURNING tipo, referencia_id, estado`,
  );
  for (const r of rows) emitAlertaActualizada(r);
  res.json({ ok: true, marcadas: rows.length });
});

/** PATCH /api/alertas/:id — cambia estado (vista/resuelta). Solo roles que pueden operar sobre lo que la alerta representa (pago, asesoría, etc.), no lectura. */
alertasRouter.patch('/:id', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const estado = req.body?.estado as string;
  if (!['nueva', 'vista', 'resuelta'].includes(estado))
    return res.status(400).json({ error: 'Estado inválido' });
  // Una entrega "a verificar" no se da por cerrada a mano: se cierra sola al
  // asignarle un contenedor disponible (POST /api/viajes/:id/asignar-contenedor).
  if (estado === 'resuelta') {
    const [pendiente] = await query(
      `SELECT 1 FROM alertas a JOIN viajes v ON v.id::text = a.referencia_id
        WHERE a.id = $1 AND a.tipo = 'contenedor_a_verificar' AND v.contenedor_numero IS NULL AND v.estado <> 'cancelado'`,
      [req.params.id],
    );
    if (pendiente) return res.status(409).json({ error: 'Primero asigná el contenedor correcto a esta entrega.' });
  }
  const [row] = await query('UPDATE alertas SET estado = $1 WHERE id = $2 RETURNING *', [estado, req.params.id]);

  // Al resolver un pedido de asesor, le devolvemos el control al bot
  // (borra la sesión: modoHumano, asignación, flujo/paso quedan limpios de nuevo).
  if (row && row.tipo === 'solicita_asesor' && estado === 'resuelta') {
    await resolverAsesor(row.referencia_id).catch((e) => console.error('Error liberando sesión:', e));
  }
  if (row) emitAlertaActualizada({ tipo: row.tipo, referencia_id: row.referencia_id, estado: row.estado });

  res.json(row);
});
