-- El cliente pidió poder asociar a cada chofer la patente del camión que
-- maneja, y que los viajes programados muestren con qué patente salió. No es
-- UNIQUE en choferes: un camión puede rotar entre choferes en distintos
-- turnos/períodos. En viajes es una foto histórica copiada al crear el viaje
-- (ver POST /api/viajes), no una referencia en vivo al chofer.
ALTER TABLE choferes ADD COLUMN patente TEXT;
ALTER TABLE viajes   ADD COLUMN patente TEXT;
