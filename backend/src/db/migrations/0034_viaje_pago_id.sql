-- 0034_viaje_pago_id.sql
-- Vincula directamente el pago inicial con el viaje creado al validar el pago
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS pago_id UUID REFERENCES pagos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_viajes_pago_id ON viajes(pago_id) WHERE pago_id IS NOT NULL;
