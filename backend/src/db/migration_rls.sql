-- =====================================================================
--  MIGRACIÓN: activar Row Level Security en todas las tablas
--  El backend accede a la DB con conexión directa (pg.Pool, ver db.ts),
--  no vía la API PostgREST de Supabase, así que no se necesitan policies:
--  el objetivo es únicamente bloquear el acceso público vía API
--  (roles anon/authenticated), que hoy no se usa para nada.
--  Correr una sola vez:
--    psql "$DATABASE_URL" -f backend/src/db/migration_rls.sql
--  Es idempotente: se puede volver a correr sin romper nada si ya se aplicó.
-- =====================================================================

BEGIN;

ALTER TABLE usuarios               ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE choferes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tarifas_departamento   ENABLE ROW LEVEL SECURITY;
ALTER TABLE contenedores           ENABLE ROW LEVEL SECURITY;
ALTER TABLE historial_contenedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets                ENABLE ROW LEVEL SECURITY;
ALTER TABLE alertas                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sesiones_chat          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensajes_chat          ENABLE ROW LEVEL SECURITY;
ALTER TABLE viajes                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensajes_procesados    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sesiones               ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispositivos_conocidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_eventos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens_accion          ENABLE ROW LEVEL SECURITY;

-- Tabla interna de la herramienta de migraciones, no forma parte de schema.sql.
ALTER TABLE IF EXISTS schema_migrations ENABLE ROW LEVEL SECURITY;

COMMIT;
