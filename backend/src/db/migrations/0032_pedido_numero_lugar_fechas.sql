-- Campos nuevos del resumen de pedido (sección "Pedido" del bot):
--  - numero_pedido: identificador corto para mostrarle al cliente (antes solo
--    existía el UUID interno, poco práctico para decirlo/escribirlo).
--  - tipo_lugar / en_via_publica: caso borde "datos que el GPS no da" — se
--    preguntan después de confirmar la ubicación.
--  - fecha_entrega / fecha_retiro_estimada: día hábil elegido por el cliente
--    y el cálculo de cuándo vence el alquiler (entrega + 7 días), guardados
--    para poder mostrarlos en el resumen y no tener que recalcularlos.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero_pedido SERIAL;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo_lugar TEXT
  CHECK (tipo_lugar IN ('casa', 'obra', 'comercio', 'consorcio'));
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS en_via_publica BOOLEAN;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fecha_entrega DATE;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fecha_retiro_estimada DATE;
