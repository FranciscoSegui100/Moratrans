-- Pedidos del bot cuyo único pago se rechazó: quedaban abiertos y seguían
-- sumando como deuda del cliente. Desde ahora "Rechazar" los cancela (ver
-- POST /api/pagos/:id/rechazar); esto arregla los que ya estaban así.
UPDATE pedidos pe SET estado = 'cancelado'
 WHERE pe.estado NOT IN ('cancelado', 'completado')
   AND EXISTS (SELECT 1 FROM pagos p WHERE p.pedido_id = pe.id AND p.estado = 'rechazado')
   AND NOT EXISTS (SELECT 1 FROM pagos p WHERE p.pedido_id = pe.id AND p.estado IN ('pendiente', 'validado'))
   AND NOT EXISTS (SELECT 1 FROM pagos p JOIN viajes v ON v.pago_id = p.id WHERE p.pedido_id = pe.id);
