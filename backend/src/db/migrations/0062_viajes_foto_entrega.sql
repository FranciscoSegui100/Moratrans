-- Foto tomada por el chofer al entregar el contenedor en la locación del cliente.
-- Se guarda cifrada en el bucket comprobantes/ (mismo mecanismo que pagos.url_comprobante
-- y mensajes_chat.adjunto_ruta) para poder verla desde la ficha del cliente y desde Conversaciones.
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS foto_entrega_url TEXT;
