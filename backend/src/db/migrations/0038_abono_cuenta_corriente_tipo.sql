-- Nuevo tipo de pago: un cliente de cuenta corriente aprobada manda un
-- comprobante para pagar (parcial o totalmente) su saldo acumulado, en vez
-- de estar atado a un pedido puntual (ver registrarAbonoCuentaCorriente en
-- pago.flow.ts). ALTER TYPE ADD VALUE no puede usarse en la misma
-- transacción en la que se referencia como valor, así que va sola en esta
-- migración — la lógica que la usa (POST /api/pagos/:id/validar) se agrega
-- después, sin necesidad de otra migración.
ALTER TYPE tipo_pago ADD VALUE 'abono_cc';
