-- =====================================================================
--  MIGRACIÓN: autenticación reforzada (MFA, sesiones, auditoría, dispositivos)
--  Correr una sola vez contra una base ya existente (schema.sql original ya aplicado):
--    psql "$DATABASE_URL" -f backend/src/db/migration_auth.sql
--  Es idempotente: se puede volver a correr sin romper nada si ya se aplicó.
--  Estos mismos cambios ya están incluidos en schema.sql para instalaciones nuevas.
-- =====================================================================

BEGIN;

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS mfa_secret_enc   TEXT,                 -- secreto TOTP cifrado (AES-256-GCM, ver crypto.service.ts)
  ADD COLUMN IF NOT EXISTS mfa_enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mfa_backup_codes TEXT[]      NOT NULL DEFAULT '{}', -- códigos de un solo uso, hasheados (bcrypt)
  ADD COLUMN IF NOT EXISTS telefono         TEXT,                 -- E.164, para 2FA por SMS
  ADD COLUMN IF NOT EXISTS google_sub       TEXT UNIQUE,          -- id estable de Google, vincula la cuenta al loguear con Google
  ADD COLUMN IF NOT EXISTS failed_attempts  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ultima_conexion  TIMESTAMPTZ;

-- Refresh tokens: uno por sesión activa, encadenados por rotación. El valor
-- real nunca se guarda, sólo su hash (sha256) — igual que una contraseña.
CREATE TABLE IF NOT EXISTS sesiones (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id         UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  device_hash        TEXT,
  user_agent         TEXT,
  ip                 TEXT,
  recordar           BOOLEAN NOT NULL DEFAULT FALSE,   -- "recordarme": refresh de vida más larga
  reemplaza_a        UUID REFERENCES sesiones(id) ON DELETE SET NULL, -- cadena de rotación
  revocada_en        TIMESTAMPTZ,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en          TIMESTAMPTZ NOT NULL,
  ultimo_uso_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones(usuario_id) WHERE revocada_en IS NULL;

-- Dispositivos ya vistos por usuario, para detectar logins desde uno nuevo.
CREATE TABLE IF NOT EXISTS dispositivos_conocidos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id     UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  device_hash    TEXT NOT NULL,
  user_agent     TEXT,
  ip_primera_vez TEXT,
  primera_vez    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_vez     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, device_hash)
);

-- Auditoría de todo evento relevante de autenticación.
DO $$ BEGIN
  CREATE TYPE tipo_evento_auth AS ENUM (
    'login_exitoso', 'login_fallido', 'mfa_fallido', 'bloqueo_temporal',
    'logout', 'password_reset_solicitado', 'password_reset_exitoso',
    'dispositivo_nuevo', 'sesion_revocada', 'refresh_reutilizado'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth_eventos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  email      TEXT,                     -- se guarda aunque el usuario no exista (login fallido a email inexistente)
  tipo       tipo_evento_auth NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  detalle    JSONB,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_eventos_usuario ON auth_eventos(usuario_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_auth_eventos_creado  ON auth_eventos(creado_en DESC);

-- Tokens de un solo uso: invitación de alta y reset de contraseña.
DO $$ BEGIN
  CREATE TYPE tipo_token_accion AS ENUM ('invitacion', 'reset_password');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tokens_accion (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo       tipo_token_accion NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 del token real (el real sólo viaja por email)
  expira_en  TIMESTAMPTZ NOT NULL,
  usado_en   TIMESTAMPTZ,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tokens_accion_usuario ON tokens_accion(usuario_id);

COMMIT;
