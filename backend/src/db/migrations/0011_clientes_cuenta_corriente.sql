-- El cliente pidió poder ofrecer cuenta corriente: clientes que pagan a fin
-- de mes o cuando se juntan varios retiros, en vez de transferir antes de
-- cada uno. `clientes` estaba definida pero nunca se usaba (todo el resto del
-- sistema referencia al cliente por teléfono suelto) — se sigue esa misma
-- convención de "soft-reference por teléfono" en vez de agregar cliente_id a
-- pedidos/pagos/viajes; ver comentario de cabecera de schema.sql.
--
-- es_cuenta_corriente en pagos permite que el pago se registre y valide con
-- el mismo camino de siempre (fn_validar_pago) pero sin exigir comprobante.
DO $$ BEGIN
  CREATE TYPE estado_cuenta_corriente AS ENUM ('sin_pedir', 'pendiente', 'aprobada', 'rechazada');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cuenta_corriente_estado estado_cuenta_corriente NOT NULL DEFAULT 'sin_pedir';

ALTER TABLE pagos ADD COLUMN IF NOT EXISTS es_cuenta_corriente BOOLEAN NOT NULL DEFAULT FALSE;
