-- =====================================================================
--  MIGRACIÓN: eventos de auditoría para MFA (Fase 4)
--  Correr una sola vez contra una base donde ya se aplicó migration_auth.sql:
--    psql "$DATABASE_URL" -f backend/src/db/migration_mfa.sql
--  Idempotente (ADD VALUE IF NOT EXISTS). Estos valores ya están incluidos
--  en schema.sql para instalaciones nuevas.
-- =====================================================================

ALTER TYPE tipo_evento_auth ADD VALUE IF NOT EXISTS 'mfa_activado';
ALTER TYPE tipo_evento_auth ADD VALUE IF NOT EXISTS 'mfa_desactivado';
