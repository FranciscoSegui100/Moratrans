-- Recambios cargados desde "Gestionar contenedor" antes del fix que movió el
-- cobro a la pata "entrega": quedaron con importe/es_cuenta_corriente en el
-- retiro del lleno y la entrega en blanco. La ficha del cliente ahora solo
-- muestra el cobro en la entrega, así que se lo pasa ahí (sin pisar una
-- entrega que ya tenga importe propio) y se lo saca del retiro, para que no
-- sume dos veces a la deuda.
UPDATE viajes e
   SET importe = r.importe, es_cuenta_corriente = r.es_cuenta_corriente
  FROM viajes r
 WHERE r.grupo_id = e.grupo_id
   AND r.tipo = 'retiro' AND e.tipo = 'entrega'
   AND r.importe IS NOT NULL AND e.importe IS NULL;

UPDATE viajes r
   SET importe = NULL, es_cuenta_corriente = FALSE
 WHERE r.tipo = 'retiro' AND r.grupo_id IS NOT NULL AND r.importe IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM viajes e
      WHERE e.grupo_id = r.grupo_id AND e.tipo = 'entrega' AND e.importe IS NOT NULL
   );
