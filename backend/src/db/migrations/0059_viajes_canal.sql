-- Corrige 0058: viajes YA tenía una columna `origen` (migración 0022,
-- 'planificada'/'agregada_en_dia', para la ruta del día), así que el
-- ADD COLUMN IF NOT EXISTS de 0058 no hizo nada en viajes y guardar
-- 'panel' ahí rompía ese CHECK. El "de dónde salió" va en su propia
-- columna: `canal` — 'bot' (lo pidió el cliente por WhatsApp) o 'panel'
-- (lo cargó un operador a mano). En pedidos 0058 sí la creó como `origen`:
-- se renombra para que se llame igual en las dos tablas.
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'bot' CHECK (canal IN ('bot', 'panel'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'pedidos' AND column_name = 'origen'
  ) THEN
    ALTER TABLE pedidos RENAME COLUMN origen TO canal;
  END IF;
END $$;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'bot' CHECK (canal IN ('bot', 'panel'));

-- Viajes ya existentes cargados a mano (mismo criterio que intentaba 0058):
-- todo lo que crea el bot sale con una nota propia o con un pago asociado;
-- "Programar nuevo viaje" no carga nota ni pago, y "Viaje manual" deja
-- siempre la misma nota. Los que se cargaron desde "Gestionar contenedor"
-- antes de este arreglo fallaron, así que no hay ninguno que rescatar.
UPDATE viajes SET canal = 'panel'
 WHERE canal = 'bot'
   AND pago_id IS NULL
   AND (notas IS NULL OR notas = 'Cargado a mano desde el perfil del cliente');
