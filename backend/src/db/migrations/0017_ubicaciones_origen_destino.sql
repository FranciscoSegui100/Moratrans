-- Todo viaje (entrega/retiro/recambio) tiene que tener dirección de origen Y
-- de destino. Hoy `viajes.destino_direccion` guarda la dirección del cliente
-- (destino de una entrega, origen de un retiro) pero no hay ningún concepto
-- de "de dónde sale" el contenedor del lado de la empresa. La empresa puede
-- tener más de un depósito (de donde salen los vacíos) y el vaciado del
-- lleno pasa en un lugar distinto (vaciadero) — ambos con varias ubicaciones
-- posibles, así que se modelan como una tabla, no una dirección fija.
--
-- No se renombra `destino_direccion`: sigue siendo "la dirección del
-- cliente" en ambos tipos de viaje. Origen/destino final se arma en las
-- consultas según `tipo` (ver GET /api/viajes):
--   Entrega: origen = ubicacion_direccion (depósito), destino = destino_direccion (cliente)
--   Retiro:  origen = destino_direccion (cliente), destino = ubicacion_direccion (vaciadero)
CREATE TYPE tipo_ubicacion AS ENUM ('deposito', 'vaciadero');

CREATE TABLE ubicaciones (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo      tipo_ubicacion NOT NULL,
  nombre    TEXT NOT NULL,
  direccion TEXT NOT NULL,
  activo    BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ubicaciones_tipo ON ubicaciones(tipo) WHERE activo = TRUE;

ALTER TABLE viajes ADD COLUMN ubicacion_id UUID REFERENCES ubicaciones(id) ON DELETE SET NULL;
-- Foto de la dirección al crear el viaje (mismo patrón que viajes.patente):
-- si después se edita o desactiva la ubicación, el historial no cambia solo.
ALTER TABLE viajes ADD COLUMN ubicacion_direccion TEXT;
