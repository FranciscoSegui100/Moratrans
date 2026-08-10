-- =====================================================================
--  MIGRACIÓN: ubicación de entrega en pedidos (GPS de WhatsApp o dirección escrita)
--  Correr una sola vez contra la base de producción (Supabase):
--    psql "$DATABASE_URL" -f backend/src/db/migration_ubicacion.sql
--  También podés pegar el contenido en el SQL Editor de Supabase y ejecutarlo.
--  Idempotente (ADD COLUMN IF NOT EXISTS). Estas columnas ya están incluidas
--  en schema.sql para instalaciones nuevas.
-- =====================================================================

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS destino_lat NUMERIC(9,6);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS destino_lng NUMERIC(9,6);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS destino_direccion TEXT;
