-- "Alargar retiro": un cliente que ya tiene un contenedor entregado puede
-- pagar el 50% de su último pago validado para sumar 5 días más al
-- vencimiento (ver alargarRetiro.flow.ts). No encaja en el circuito normal
-- de pagos (fn_validar_pago crea un ticket/reserva ligado a un pedido) — es
-- un tipo de pago aparte que, al validarse, solo corre vence_en (ver
-- POST /api/pagos/:id/validar).
CREATE TYPE tipo_pago AS ENUM ('flete', 'alargue_retiro');
ALTER TABLE pagos ADD COLUMN tipo tipo_pago NOT NULL DEFAULT 'flete';
-- Contenedor a extender. Solo se usa cuando tipo = 'alargue_retiro' — en un
-- pago normal el contenedor se resuelve recién al validar (fn_validar_pago).
ALTER TABLE pagos ADD COLUMN contenedor_numero TEXT REFERENCES contenedores(numero) ON DELETE SET NULL;

ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'alargue_solicitado';
