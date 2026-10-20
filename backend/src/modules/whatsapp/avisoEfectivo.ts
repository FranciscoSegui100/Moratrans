/**
 * Línea extra de estado de pago para avisarle al chofer, en cualquier
 * mensaje de asignación, si tiene que cobrar algo o no:
 *  - efectivo: se cobra contra entrega (ver migración 0043).
 *  - transferencia (el único otro medio posible — ver CHECK en
 *    pagos.medio_pago): para cuando esta función corre, el pago ya está
 *    validado (así nace el viaje, ver pagos.routes.ts), así que avisa que ya
 *    está abonado y no hay que cobrar nada.
 *  - sin medio de pago (viaje sin `pago_id`, ej. cuenta corriente o armado a
 *    mano sin pago asociado): no se puede afirmar nada, no agrega línea.
 * Compartido entre pagos.routes.ts y viajes.routes.ts para evitar un import
 * circular entre esos dos módulos.
 */
export function avisoPagoChofer(medioPago: string | null | undefined, precio: string | null | undefined): string {
  if (medioPago === 'efectivo') {
    const monto = precio ? `ARS ${Number(precio).toLocaleString('es-AR')}` : 'el importe correspondiente';
    return `\n\n💵 *PAGO EN EFECTIVO — cobrar ${monto} al entregar*`;
  }
  if (medioPago === 'transferencia') {
    return `\n\n✅ *Ya está abonado — no hace falta cobrar nada*`;
  }
  return '';
}
