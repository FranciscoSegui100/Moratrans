-- Casos borde sección 23 del documento maestro:
--
-- 1) "Un número de chofer se reasigna a otra persona sin desvincular al
--    chofer anterior" — antes la única forma de liberar un número era
--    pisarle el campo `telefono` a mano al chofer anterior (mismo PATCH
--    genérico que edita nombre/DNI). Se habilita NULL explícito para poder
--    tener un paso de "desvincular" real (ver POST /api/choferes/:id/desvincular)
--    antes de que el número quede libre para otro chofer. El índice único
--    pasa a ser parcial: dos choferes sin teléfono no chocan entre sí.
ALTER TABLE choferes ALTER COLUMN telefono DROP NOT NULL;
ALTER TABLE choferes DROP CONSTRAINT choferes_telefono_key;
CREATE UNIQUE INDEX choferes_telefono_key ON choferes(telefono) WHERE telefono IS NOT NULL;

-- 2) "Llega un segundo comprobante de pago para una cotización que ya tiene
--    uno pendiente de validar" — no debe duplicar el registro de pago/alerta,
--    sino agregarse como adjunto adicional a la misma solicitud (ver
--    pago.flow.ts). El comprobante viaja cifrado igual que pagos.url_comprobante.
CREATE TABLE pagos_adjuntos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pago_id         UUID NOT NULL REFERENCES pagos(id) ON DELETE CASCADE,
  url_comprobante TEXT NOT NULL,
  media_id        TEXT,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pagos_adjuntos_pago ON pagos_adjuntos(pago_id);
ALTER TABLE pagos_adjuntos ENABLE ROW LEVEL SECURITY;
