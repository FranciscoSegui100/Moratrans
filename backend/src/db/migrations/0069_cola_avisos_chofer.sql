-- Avisos nuevos para un chofer que está en medio de algo (entregando,
-- eligiendo contenedor, sacando la foto, contestando el cobro): no se le
-- mandan en el momento, quedan acá y le llegan cuando termina lo que estaba
-- haciendo (ver despachoRutas.service.ts::liberarColaChofer).
CREATE TABLE IF NOT EXISTS cola_avisos_chofer (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chofer_id UUID NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
  ruta_id   UUID REFERENCES rutas(id) ON DELETE CASCADE,
  viaje_id  UUID REFERENCES viajes(id) ON DELETE CASCADE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((ruta_id IS NULL) <> (viaje_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cola_avisos_chofer_ruta ON cola_avisos_chofer (chofer_id, ruta_id) WHERE ruta_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cola_avisos_chofer_viaje ON cola_avisos_chofer (chofer_id, viaje_id) WHERE viaje_id IS NOT NULL;
