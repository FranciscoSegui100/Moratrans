-- Dos cosas distintas: el rango horario que el cliente elige por WhatsApp al
-- pedir una entrega o un recambio (franjas fijas, ver
-- horarioPreferido.flow.ts) y la hora estimada que carga el operador desde
-- el panel de Viajes (llegada si es una entrega, retiro si es un retiro) —
-- la primera es un pedido del cliente, la segunda el compromiso real que
-- arma el operador; no tienen por qué coincidir.
ALTER TABLE pedidos ADD COLUMN horario_preferido TEXT;
ALTER TABLE viajes  ADD COLUMN horario_preferido TEXT;
ALTER TABLE viajes  ADD COLUMN hora_estimada TIME;
