-- OJO: reemplazada por 0059_viajes_canal.sql — viajes ya tenía una columna
-- `origen` (0022) con otro significado, así que acá no se creó nada en
-- viajes. Se deja como está porque ya corrió en las bases existentes.
--
-- De dónde salió cada viaje/pedido: 'bot' (lo pidió el cliente por WhatsApp)
-- o 'panel' (lo cargó un operador a mano — "Programar nuevo viaje" en Rutas,
-- "Viaje manual" en el perfil del cliente, o "Gestionar contenedor"). Lo usa
-- "Gestionar contenedor" (contenedores/gestion.routes.ts): recambio, retiro y
-- extensión desde el panel solo se ofrecen si la entrega vigente del
-- contenedor se cargó a mano.
ALTER TABLE viajes  ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'bot' CHECK (origen IN ('bot', 'panel'));
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'bot' CHECK (origen IN ('bot', 'panel'));

-- Viajes ya existentes cargados a mano: todo lo que crea el bot sale con
-- una nota propia ("Creado al validar el pago…", "Pedido de … por WhatsApp…")
-- o con un pago asociado; "Programar nuevo viaje" no carga nota ni pago, y
-- "Viaje manual" deja siempre la misma nota.
UPDATE viajes SET origen = 'panel'
 WHERE origen = 'bot'
   AND pago_id IS NULL
   AND (notas IS NULL OR notas = 'Cargado a mano desde el perfil del cliente');
