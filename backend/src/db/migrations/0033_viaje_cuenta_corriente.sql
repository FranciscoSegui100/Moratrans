-- Marca si un viaje de entrega se pidió directo por cuenta corriente (ver
-- pedirEntrega.flow.ts) — a diferencia de una entrega que vino de cotizar y
-- pagar (con o sin cuenta corriente), este viaje no tiene un `pedido`
-- asociado, así que no hay otro lugar de donde inferir que es deuda de
-- cuenta corriente para el resumen (ver reportes.service.ts).
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS es_cuenta_corriente BOOLEAN NOT NULL DEFAULT FALSE;
