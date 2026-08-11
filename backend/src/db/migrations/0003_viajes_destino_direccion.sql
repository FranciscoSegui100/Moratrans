-- Dirección de destino para viajes programados a mano desde el panel (antes
-- solo existía para pedidos que venían del flujo de cotización de WhatsApp).
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS destino_direccion TEXT;
