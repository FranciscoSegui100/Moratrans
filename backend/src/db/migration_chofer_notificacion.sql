-- =====================================================================
--  MIGRACIÓN: nombre del cliente en pedidos (para el aviso al chofer)
--  Correr una sola vez contra la base de producción (Supabase):
--    psql "$DATABASE_URL" -f backend/src/db/migration_chofer_notificacion.sql
--  También podés pegar el contenido en el SQL Editor de Supabase y ejecutarlo.
--  Idempotente (ADD COLUMN IF NOT EXISTS). Ya está incluida en schema.sql
--  para instalaciones nuevas.
-- =====================================================================

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cliente_nombre TEXT;
