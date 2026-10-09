-- Qué servicio fue (texto libre cargado por el operador) — solo tiene
-- sentido para tipo = 'otro_servicio'; el resto de los pagos ya sabe qué son
-- por su tipo/pedido. Nullable para no romper los pagos existentes.
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS concepto TEXT;
