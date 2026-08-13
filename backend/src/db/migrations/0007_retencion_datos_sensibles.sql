-- Sección 9 del documento maestro (Ley 25.326: guardar datos sensibles solo
-- el tiempo necesario). Dos políticas de retención, ambas ejecutadas por
-- limpieza.cron.ts:
--
-- 1) DNI de chofer: se anonimiza (dni_enc/dni_hash -> NULL) a los 365 días
--    de que el chofer queda inactivo. Para poder contarlos hace falta saber
--    desde cuándo está inactivo -> se agrega `desactivado_en` (lo mantiene
--    el PATCH de choferes.routes.ts al togglear `activo`).
ALTER TABLE choferes ALTER COLUMN dni_enc DROP NOT NULL;
ALTER TABLE choferes ALTER COLUMN dni_hash DROP NOT NULL;
ALTER TABLE choferes ADD COLUMN desactivado_en TIMESTAMPTZ;
-- Choferes que ya estaban inactivos antes de esta migración: no se puede
-- saber retroactivamente desde cuándo, así que el conteo de 365 días
-- arranca desde ahora (mejor esto que anonimizarlos todos de golpe).
UPDATE choferes SET desactivado_en = now() WHERE activo = FALSE;

-- 2) Comprobantes de pago (pagos.url_comprobante/factura_url y
--    pagos_adjuntos.url_comprobante): se purgan (archivo del storage +
--    referencia en DB) a los 2 años de creados. Se conserva la fila de
--    `pagos` en sí (monto, estado, fechas) para trazabilidad contable/impositiva.
