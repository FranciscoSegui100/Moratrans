-- El operador necesita saber a nombre de quién llegó la transferencia para
-- poder conciliarla (el comprobante no siempre trae un nombre legible, y el
-- que paga no siempre es el mismo número de WhatsApp que cotiza). Se pide
-- por chat justo después de recibir el comprobante (ver pago.flow.ts).
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS titular_transferencia TEXT;
