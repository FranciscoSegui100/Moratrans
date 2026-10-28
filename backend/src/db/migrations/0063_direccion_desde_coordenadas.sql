-- Pedidos/viajes que llegaron por pin de WhatsApp sin dirección de texto
-- (Nominatim no contestó): se les pone las coordenadas como dirección, igual
-- que hace ahora direccionDeUbicacion en geocoding.service.ts, para que el
-- aviso al chofer tenga el link de Google Maps en vez de "Sin dirección registrada".
UPDATE pedidos
   SET destino_direccion = destino_lat::text || ', ' || destino_lng::text
 WHERE destino_direccion IS NULL AND destino_lat IS NOT NULL AND destino_lng IS NOT NULL;

UPDATE viajes
   SET destino_direccion = destino_lat::text || ', ' || destino_lng::text
 WHERE destino_direccion IS NULL AND destino_lat IS NOT NULL AND destino_lng IS NOT NULL;
