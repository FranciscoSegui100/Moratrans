-- Rediseño "ruta viva": la ruta nunca se cierra al confirmar, así que hace
-- falta poder distinguir qué se planificó a la mañana de lo que entró
-- durante el día, marcar cuándo se completó cada parada, evitar reservar dos
-- veces al reintentar `confirmar`, y guardar la capacidad del camión para la
-- advertencia de sobrecarga (ver disponibilidad.service.ts).

-- Cuándo el chofer marcó esta parada como hecha (entrega/retiro). Alimenta la
-- vista día: "marcó hace X min" por chofer.
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS completada_en TIMESTAMPTZ;

-- Si la parada se armó en la planificación de la mañana o entró después,
-- con la ruta ya en curso.
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'planificada'
  CHECK (origen IN ('planificada', 'agregada_en_dia'));

-- Marca cuándo `POST /rutas/:id/confirmar` ya reservó/avisó esta parada —
-- permite que confirmar sea idempotente y reintentable (reserva lo nuevo,
-- no toca ni vuelve a avisar lo ya confirmado en una corrida anterior).
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS ruta_confirmada_en TIMESTAMPTZ;

-- Capacidad del camión que maneja cada chofer: a lo sumo 1 contenedor lleno
-- a bordo, vacíos hasta ~6 (típico 2-3) — ver reunión del 21/08.
ALTER TABLE choferes ADD COLUMN IF NOT EXISTS capacidad_llenos INT NOT NULL DEFAULT 1;
ALTER TABLE choferes ADD COLUMN IF NOT EXISTS capacidad_vacios INT NOT NULL DEFAULT 6;

-- Lock optimista sobre la ruta: dos operadores pueden estar armando la misma
-- ruta a la vez (panel + WhatsApp de un dueño); el segundo en guardar un
-- reordenamiento tiene que enterarse en vez de pisar al primero.
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
