-- Nuevo tipo de pago para la transferencia de un pedido armado en el
-- catálogo de WhatsApp (ver pedidoCatalogo.flow.ts): no tiene pedido_id (no
-- pasa por cotización, no tiene zona/precio) así que necesita su propio tipo
-- para no mezclarse con 'flete' ni reusar 'otro_servicio' (ese es para
-- ingresos cargados a mano por un operador, sin comprobante del bot).
-- ADD VALUE va solo en su propia transacción/archivo (igual que 0047).
ALTER TYPE tipo_pago ADD VALUE IF NOT EXISTS 'pedido_catalogo';
