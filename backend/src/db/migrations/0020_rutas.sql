-- Pestaña "Ruta": pre-planificación del recorrido diario de un chofer.
-- Extiende `viajes` en vez de duplicarlo con tablas paralelas — ver plan.
-- `viajes` ya es la parada ejecutable (chofer_id, contenedor_numero, tipo,
-- grupo_id para emparejar el recambio); acá solo se agrega la secuencia.

CREATE TYPE estado_ruta AS ENUM ('planificada', 'en_curso', 'finalizada', 'cancelada');

CREATE TABLE rutas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha       DATE NOT NULL,
  chofer_id   UUID NOT NULL REFERENCES choferes(id) ON DELETE RESTRICT,
  -- Foto de choferes.patente al armar la ruta (mismo patrón que viajes.patente).
  patente     TEXT,
  estado      estado_ruta NOT NULL DEFAULT 'planificada',
  armada_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  notas       TEXT,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rutas_fecha_chofer ON rutas(fecha, chofer_id);
CREATE INDEX idx_rutas_estado ON rutas(estado);
-- Una sola ruta activa (no cancelada) por chofer por día.
CREATE UNIQUE INDEX ux_rutas_chofer_fecha ON rutas(chofer_id, fecha) WHERE estado <> 'cancelada';
CREATE TRIGGER trg_touch_rutas BEFORE UPDATE ON rutas
  FOR EACH ROW EXECUTE FUNCTION fn_touch_actualizado(); -- ya existe (schema.sql)
ALTER TABLE rutas ENABLE ROW LEVEL SECURITY;

-- Parada de vaciado: NO referencia un contenedor puntual — libera de una
-- todo el set "pendiente de vaciar" acumulado hasta ese punto de la ruta
-- (la regla de disponibilidad opera sobre el set completo, no sobre una
-- unidad), por eso no es una fila de `viajes`.
CREATE TABLE ruta_vaciados (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruta_id      UUID NOT NULL REFERENCES rutas(id) ON DELETE CASCADE,
  orden        INT  NOT NULL,
  ubicacion_id UUID REFERENCES ubicaciones(id) ON DELETE SET NULL, -- vaciadero
  notas        TEXT,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ruta_id, orden)
);
ALTER TABLE ruta_vaciados ENABLE ROW LEVEL SECURITY;

-- Extiende viajes: una parada simple de entrega/retiro = una fila de viajes
-- con ruta_id+orden. Un recambio en una ruta = las dos filas (mismo
-- grupo_id) comparten ruta_id Y orden (misma visita física).
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS ruta_id UUID REFERENCES rutas(id) ON DELETE SET NULL;
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS orden   INT;

-- No puede haber orden sin ruta ni ruta sin orden: son la misma decisión.
ALTER TABLE viajes ADD CONSTRAINT chk_viajes_ruta_orden
  CHECK ((ruta_id IS NULL) = (orden IS NULL));

-- Unique por (ruta_id, orden, tipo): permite que entrega+retiro de un mismo
-- recambio compartan (ruta_id, orden) porque difieren en tipo, pero impide
-- que dos paradas DISTINTAS choquen en el mismo número.
CREATE UNIQUE INDEX ux_viajes_ruta_orden_tipo ON viajes(ruta_id, orden, tipo) WHERE ruta_id IS NOT NULL;
CREATE INDEX idx_viajes_ruta ON viajes(ruta_id) WHERE ruta_id IS NOT NULL;
