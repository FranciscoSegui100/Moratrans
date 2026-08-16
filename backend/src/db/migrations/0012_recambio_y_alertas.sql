-- Recambio: el chofer deja un contenedor vacío y se lleva el lleno en la
-- misma visita. Se modela como dos filas de `viajes` (una 'entrega' del
-- vacío + una 'retiro' del lleno) unidas por grupo_id, en vez de un tipo de
-- viaje nuevo: así se reutiliza toda la lógica existente de cada tipo sin
-- tocarla.
--
-- ALTER TYPE ... ADD VALUE no se puede USAR en la misma transacción en la
-- que se agrega (Postgres lo bloquea) — como esta migración no inserta ni
-- filtra por los valores nuevos, se puede agregar junto con lo demás (migrate.ts
-- ya envuelve todo el archivo en una única transacción).
ALTER TABLE viajes ADD COLUMN grupo_id UUID;
CREATE INDEX idx_viajes_grupo ON viajes(grupo_id) WHERE grupo_id IS NOT NULL;

ALTER TYPE tipo_alerta ADD VALUE 'cuenta_corriente_solicitada';
ALTER TYPE tipo_alerta ADD VALUE 'recambio_solicitado';
