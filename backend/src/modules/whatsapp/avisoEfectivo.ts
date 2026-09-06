/**
 * Línea extra para avisarle al chofer, en cualquier mensaje de asignación,
 * que el pedido se cobra en efectivo contra entrega (ver migración 0043).
 * Compartido entre pagos.routes.ts (entrega/recambio) para evitar un import
 * circular entre esos dos módulos de rutas.
 */
export function avisoEfectivoChofer(medioPago: string | null | undefined, precio: string | null | undefined): string {
  if (medioPago !== 'efectivo') return '';
  const monto = precio ? `ARS ${Number(precio).toLocaleString('es-AR')}` : 'el importe correspondiente';
  return `\n\n💵 *PAGO EN EFECTIVO — cobrar ${monto} al entregar*`;
}
