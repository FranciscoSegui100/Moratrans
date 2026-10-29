-- Lo que escribió el chofer al tocar "Ya entregué", tal cual. Una entrega
-- hecha (completada_en) sin contenedor_numero queda "a verificar": la
-- oficina ve este número y asigna el contenedor correcto.
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS contenedor_informado TEXT;
