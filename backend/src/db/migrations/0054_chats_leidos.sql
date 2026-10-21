-- Se saca "fijar chats" (0053): la tabla queda sin uso.
DROP TABLE IF EXISTS chats_fijados;

-- Leído / no leído en Conversaciones, POR USUARIO del panel: hasta cuándo
-- leyó cada operador cada chat. Un mensaje del cliente posterior a
-- `leido_en` cuenta como no leído para ese operador (no para los demás).
CREATE TABLE IF NOT EXISTS chats_leidos (
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  telefono   TEXT NOT NULL,
  leido_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, telefono)
);
ALTER TABLE chats_leidos ENABLE ROW LEVEL SECURITY;

-- Arranque: todo el historial que ya existe queda como leído para todos,
-- así al deployar no aparecen cientos de chats viejos como "no leídos".
INSERT INTO chats_leidos (usuario_id, telefono, leido_en)
SELECT u.id, m.telefono, now()
  FROM usuarios u
 CROSS JOIN (SELECT DISTINCT telefono FROM mensajes_chat) m
ON CONFLICT DO NOTHING;
