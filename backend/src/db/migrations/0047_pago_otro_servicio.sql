-- Nuevo tipo de pago para ingresos de servicios fuera del alquiler de
-- contenedores (cliente elige "Otros servicios" en el menú de WhatsApp, lo
-- atiende un asesor humano por fuera del bot — ver asesor.flow.ts — y el
-- operador carga el ingreso a mano desde Finanzas). A diferencia de
-- 'abono_cc', este SÍ cuenta como venta nueva en finanzas.service.ts.
-- ADD VALUE va solo en su propia transacción/archivo (igual que 0001, 0012,
-- 0014): Postgres no deja usarlo en la misma transacción en la que se agrega.
ALTER TYPE tipo_pago ADD VALUE IF NOT EXISTS 'otro_servicio';
