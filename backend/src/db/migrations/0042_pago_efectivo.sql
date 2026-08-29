-- 0042_pago_efectivo.sql
-- Agrega la opción de pago en efectivo para clientes ocasionales (antes solo
-- existía transferencia, o cuenta corriente para quien ya la tuviera
-- aprobada). `medio_pago` distingue cómo se va a cobrar; `efectivo_cobrado`
-- es independiente del estado del pago: `pagos.estado = 'validado'` acá
-- significa "pedido confirmado y contenedor reservado" (igual que siempre),
-- no "plata ya recibida" — el cobro real en mano lo marca un operador aparte
-- cuando efectivamente ocurre (ver PATCH /api/pagos/:id/cobrado).

ALTER TABLE pagos
  ADD COLUMN medio_pago TEXT NOT NULL DEFAULT 'transferencia'
    CHECK (medio_pago IN ('transferencia', 'efectivo')),
  ADD COLUMN efectivo_cobrado BOOLEAN NOT NULL DEFAULT FALSE;
