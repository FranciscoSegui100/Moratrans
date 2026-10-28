-- Alerta para el panel cuando el chofer entrega y elige con qué contenedor:
-- desde el flujo nuevo el contenedor de una entrega no se asigna antes, lo
-- elige el chofer al tocar "Ya entregué" (ver asignacionEntrega.service.ts).
-- La oficina se entera por acá de qué contenedor quedó en cada cliente.
ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'contenedor_entregado';
