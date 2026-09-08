-- Migration to drop DNI columns from choferes table
ALTER TABLE choferes DROP COLUMN IF EXISTS dni_enc;
ALTER TABLE choferes DROP COLUMN IF EXISTS dni_hash;
