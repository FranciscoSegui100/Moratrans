-- Interruptor manual para pausar la atención automática a CLIENTES (ej.
-- fuera de horario) sin tocar código ni la sesión de nadie — ver
-- botConfig.service.ts y el botón "Desactivar bot" del Dashboard. No afecta
-- a los choferes (ver messageRouter.ts::enrutar), que siguen operando su
-- propio menú siempre; la logística en curso no puede depender de este switch.
CREATE TABLE configuracion_bot (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- fila única (singleton)
  bot_activo      BOOLEAN NOT NULL DEFAULT TRUE,
  actualizado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO configuracion_bot (id, bot_activo) VALUES (1, TRUE);
