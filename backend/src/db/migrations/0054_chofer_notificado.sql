-- Agrega columna chofer_notificado_en a viajes: permite confirmar una ruta
-- con días de anticipación (reservando contenedores y avisando al cliente)
-- sin enviarle al chofer la primera parada interactiva hasta la mañana del día del reparto.
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS chofer_notificado_en TIMESTAMPTZ;

-- Para viajes ya confirmados en el pasado, se considera que el chofer ya fue notificado
UPDATE viajes SET chofer_notificado_en = ruta_confirmada_en
 WHERE ruta_confirmada_en IS NOT NULL AND chofer_notificado_en IS NULL;
