-- Los alargues cargados desde "Gestionar contenedor" le copiaban su cobro
-- (pago_id, importe, es_cuenta_corriente) al viaje de retiro que
-- reprogramaban. Ahora cada alargue es su propia fila en la ficha del
-- cliente (su pago 'alargue_retiro'), así que esos retiros vuelven a ser
-- retiros a secas — si no, ese cobro se vería dos veces.
--
-- Solo toca retiros sueltos (sin grupo_id, no son mitad de un recambio)
-- cuyo pago_id apunta a un pago de tipo alargue_retiro: es exactamente lo
-- que dejaba el endpoint viejo, ningún otro camino arma esa combinación.
UPDATE viajes v
   SET pago_id = NULL, importe = NULL, es_cuenta_corriente = FALSE
  FROM pagos p
 WHERE v.pago_id = p.id
   AND p.tipo = 'alargue_retiro'
   AND v.tipo = 'retiro'
   AND v.grupo_id IS NULL;
