-- Permite corregir el número de un contenedor (ej. error de tipeo al darlo
-- de alta) sin dejar huérfanas las filas que ya lo referencian. Las FK
-- apuntando a contenedores(numero) no tenían ON UPDATE CASCADE, así que
-- renombrar la fila padre fallaba apenas existía una sola fila hija (incluido
-- historial_contenedores, que SIEMPRE tiene al menos una fila desde el alta).
-- Los nombres de constraint son los auto-generados por Postgres para un
-- REFERENCES inline de una sola columna: "<tabla>_<columna>_fkey".
ALTER TABLE historial_contenedores DROP CONSTRAINT historial_contenedores_numero_contenedor_fkey,
  ADD CONSTRAINT historial_contenedores_numero_contenedor_fkey
    FOREIGN KEY (numero_contenedor) REFERENCES contenedores(numero) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE pedidos DROP CONSTRAINT pedidos_contenedor_recambio_numero_fkey,
  ADD CONSTRAINT pedidos_contenedor_recambio_numero_fkey
    FOREIGN KEY (contenedor_recambio_numero) REFERENCES contenedores(numero) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE pagos DROP CONSTRAINT pagos_contenedor_numero_fkey,
  ADD CONSTRAINT pagos_contenedor_numero_fkey
    FOREIGN KEY (contenedor_numero) REFERENCES contenedores(numero) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE tickets DROP CONSTRAINT tickets_contenedor_numero_fkey,
  ADD CONSTRAINT tickets_contenedor_numero_fkey
    FOREIGN KEY (contenedor_numero) REFERENCES contenedores(numero) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE viajes DROP CONSTRAINT viajes_contenedor_numero_fkey,
  ADD CONSTRAINT viajes_contenedor_numero_fkey
    FOREIGN KEY (contenedor_numero) REFERENCES contenedores(numero) ON DELETE SET NULL ON UPDATE CASCADE;
