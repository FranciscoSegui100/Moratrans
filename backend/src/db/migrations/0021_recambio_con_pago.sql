-- El recambio ahora pasa por el mismo circuito de cobro/validación que una
-- entrega: se cotiza como un pedido normal (misma tarifa de la zona), el
-- cliente paga y un operador lo valida desde el panel — recién ahí se crean
-- los viajes (retiro del lleno + entrega del vacío). Antes se creaban los
-- viajes directo al confirmar por WhatsApp, sin cobrar nada (ver
-- recambio.flow.ts).
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'entrega'
  CHECK (tipo IN ('entrega', 'recambio'));
-- Solo se usa cuando tipo = 'recambio': el contenedor lleno que ya se sabe
-- que hay que retirar (viene de contenedoresDelCliente, no se vuelve a
-- preguntar). El vacío a entregar lo resuelve fn_validar_pago como siempre.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS contenedor_recambio_numero TEXT
  REFERENCES contenedores(numero) ON DELETE SET NULL;
