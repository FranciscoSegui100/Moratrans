-- Los clientes de cuenta corriente pueden pedir una entrega directa por
-- WhatsApp, sin pasar por cotización/pago (ver pedirEntrega.flow.ts) — hace
-- falta una alerta propia para que el operador la vea y asigne contenedor.
ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'entrega_solicitada';
