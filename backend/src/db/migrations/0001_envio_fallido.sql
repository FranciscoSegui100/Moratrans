-- Agrega el tipo de alerta 'envio_fallido': se usa cuando un mensaje de
-- WhatsApp crítico (aviso al chofer, factura al cliente) no se pudo
-- enviar, para que quede visible en el panel en vez de perderse en los
-- logs de Railway.
ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'envio_fallido';
