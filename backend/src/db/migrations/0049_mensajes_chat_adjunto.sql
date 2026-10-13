-- Archivo (imagen/PDF) que el cliente mandó en ese mensaje, para poder verlo
-- desde Conversaciones apenas llega, sin esperar a que quede registrado como
-- pago. Misma ruta cifrada de Supabase Storage que pagos.url_comprobante.
ALTER TABLE mensajes_chat ADD COLUMN IF NOT EXISTS adjunto_ruta TEXT;
