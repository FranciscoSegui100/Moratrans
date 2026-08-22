-- Orden de evaluación cuando dos polígonos de zona se superponen (poco común,
-- pero puede pasar en los bordes según cómo se carguen). detectarDepartamento
-- ahora recorre las zonas ordenadas por prioridad ascendente y se queda con
-- la primera que matchea, en vez de un orden arbitrario de la consulta.
ALTER TABLE tarifas_departamento ADD COLUMN IF NOT EXISTS prioridad INT NOT NULL DEFAULT 0;
