-- 0044_alerta_efectivo_no_cobrado.sql
-- Nuevo tipo de alerta: cuando el chofer marca una entrega en efectivo como
-- "Ya entregué" y responde que TODAVÍA NO cobró (ver chofer.flow.ts), se
-- avisa al panel para que un operador haga el seguimiento en persona — en
-- vez de perder ese dato en el chat del chofer o reusar 'pago_pendiente_validacion'
-- (que en Alertas.tsx dispara los botones de Validar/Rechazar, inapropiados
-- acá porque el pago YA está validado, solo falta cobrarlo).

ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'efectivo_no_cobrado';
