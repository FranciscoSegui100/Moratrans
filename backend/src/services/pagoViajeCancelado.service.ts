import { PoolClient } from 'pg';
import { emitAlertaActualizada } from '../config/socket';

const MOTIVO = 'Viaje cancelado';

/**
 * Al cancelar uno o más viajes, el pago que tenían asociado (viajes.pago_id)
 * y que todavía no se cobró queda anulado: pasa a 'rechazado' con motivo
 * "Viaje cancelado". Sin esto seguía apareciendo en Validar pagos y alguien
 * tenía que rechazarlo a mano (de deuda ya no sumaba: los cálculos excluyen
 * los viajes cancelados).
 *
 * "Todavía no se cobró" = transferencia sin validar, o efectivo no cobrado
 * por el chofer. Un pago ya cobrado de verdad (transferencia validada o
 * efectivo en mano) no se toca: esa plata entró, y devolverla o dejarla a
 * cuenta lo decide una persona.
 *
 * Si otro viaje que NO se está cancelando usa el mismo pago (ej. la otra
 * mitad de un recambio que sigue en pie), no se toca. Si el pago venía de un
 * pedido (cotización del bot), el pedido también se cancela — si no, el bot
 * se lo seguiría ofreciendo al cliente como "pedido pendiente de pago".
 *
 * Corre dentro de la transacción de la cancelación. Devuelve una función para
 * avisarle al panel las alertas resueltas, a llamar después del commit.
 */
export async function anularPagosDeViajesCancelados(c: PoolClient, viajeIds: string[]): Promise<() => void> {
  if (viajeIds.length === 0) return () => {};
  const { rows: pagos } = await c.query<{ id: string; pedido_id: string | null }>(
    `UPDATE pagos p SET estado = 'rechazado', motivo_rechazo = $2
      WHERE p.id IN (SELECT v.pago_id FROM viajes v WHERE v.id = ANY($1::uuid[]) AND v.pago_id IS NOT NULL)
        AND (p.estado = 'pendiente' OR (p.medio_pago = 'efectivo' AND p.efectivo_cobrado = FALSE AND p.estado <> 'rechazado'))
        AND NOT EXISTS (
          SELECT 1 FROM viajes otro
           WHERE otro.pago_id = p.id AND otro.estado <> 'cancelado' AND NOT (otro.id = ANY($1::uuid[]))
        )
      RETURNING p.id, p.pedido_id`,
    [viajeIds, MOTIVO],
  );
  if (pagos.length === 0) return () => {};

  const pagoIds = pagos.map((p) => p.id);
  const pedidoIds = pagos.map((p) => p.pedido_id).filter((id): id is string => !!id);
  if (pedidoIds.length > 0) {
    await c.query(
      `UPDATE pedidos SET estado = 'cancelado' WHERE id = ANY($1::uuid[]) AND estado <> 'completado'`,
      [pedidoIds],
    );
  }
  const { rows: alertas } = await c.query<{ tipo: string; referencia_id: string }>(
    `UPDATE alertas SET estado = 'resuelta'
      WHERE referencia_id = ANY($1::text[]) AND estado <> 'resuelta'
        AND tipo IN ('pago_pendiente_validacion', 'cuenta_corriente_solicitada')
      RETURNING tipo, referencia_id`,
    [pagoIds],
  );
  return () => {
    for (const a of alertas) emitAlertaActualizada({ tipo: a.tipo, referencia_id: a.referencia_id, estado: 'resuelta' });
  };
}
