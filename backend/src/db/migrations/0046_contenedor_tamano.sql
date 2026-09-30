-- Tamaño del contenedor en m³ (5, 7 o 9). Nullable: los contenedores dados
-- de alta antes de esta migración no tienen la medida cargada.
ALTER TABLE contenedores ADD COLUMN IF NOT EXISTS tamano SMALLINT
  CHECK (tamano IN (5, 7, 9));
