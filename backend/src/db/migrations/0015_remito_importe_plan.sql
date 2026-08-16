-- El cliente usa una planilla propia (Excel) para llevar el registro de
-- movimientos de contenedores, con columnas que el sistema todavía no
-- tenía: número de remito y monto por movimiento (viajes), y un "número de
-- plan" interno por cliente (clientes) — ver excelClientes() en
-- reportes.service.ts, que ahora reproduce ese mismo formato.
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS remito TEXT;
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS importe NUMERIC(12,2);

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS numero_plan INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS clientes_numero_plan_key ON clientes(numero_plan) WHERE numero_plan IS NOT NULL;
