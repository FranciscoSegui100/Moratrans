-- Chats fijados en Conversaciones, POR USUARIO del panel: cada operador fija
-- los suyos y no le cambia la lista a nadie más. Va en la base (no en el
-- navegador) para que se mantengan aunque entre desde otra PC o el celular.
CREATE TABLE IF NOT EXISTS chats_fijados (
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  telefono   TEXT NOT NULL,
  fijado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, telefono)
);
ALTER TABLE chats_fijados ENABLE ROW LEVEL SECURITY;
