/**
 * Línea extra para avisarle al chofer, en cualquier mensaje de asignación,
 * cómo se paga esta visita: si es efectivo, cuánto tiene que cobrar (ver
 * migración 0043); si es transferencia, que ya está pagada y no hace falta
 * cobrar nada — así lo sabe de entrada, sin esperar a marcar la acción para
 * enterarse (ver avisarEstadoPagoAlChofer en chofer.flow.ts, que repite el
 * mismo aviso recién al completar la parada). Compartido entre
 * pagos.routes.ts y viajes.routes.ts para evitar un import circular entre
 * esos dos módulos de rutas.
 */
export function avisoPagoChofer(
  medioPago: string | null | undefined,
  precio: string | null | undefined,
  esCuentaCorriente?: boolean | null,
): string {
  // Cuenta corriente: es deuda a pagar después, no algo que se cobre en esta
  // visita — pagos.medio_pago queda en su default 'transferencia' aunque no
  // haya ninguna transferencia real detrás, así que sin este chequeo se le
  // avisaría "ya está pagado" a un chofer que en realidad tiene que entregar
  // fiado.
  if (esCuentaCorriente) return '';
  if (medioPago === 'efectivo') {
    const monto = precio ? `ARS ${Number(precio).toLocaleString('es-AR')}` : 'el importe correspondiente';
    return `\n\n💵 *Pago en efectivo:* recordá cobrar ${monto} en esta visita.`;
  }
  if (medioPago === 'transferencia') {
    return `\n\n✅ *Ya está pagado por transferencia:* no hace falta cobrar nada.`;
  }
  return '';
}
