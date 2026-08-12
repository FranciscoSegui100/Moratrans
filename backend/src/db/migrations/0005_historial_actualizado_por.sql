-- El historial de contenedores mostraba una fila automática del trigger
-- (con el uuid crudo metido en la nota, tipo "auto: chofer:98d16c27-...")
-- y ADEMÁS una fila manual duplicada insertada a mano desde el código de
-- la app, sin forma confiable de resolver "quién" hizo el cambio. Acá:
-- 1) el trigger pasa a guardar actualizado_por con el mismo formato
--    "chofer:<uuid>" / "operador:<uuid>" que ya usa la tabla contenedores,
--    para poder resolver el nombre igual que en GET /api/contenedores.
-- 2) los inserts manuales duplicados en chofer.flow.ts y
--    contenedores.routes.ts se eliminan (ver ese commit) — el trigger ya
--    cubre el 100% de las transiciones de estado por sí solo.
ALTER TABLE historial_contenedores ADD COLUMN IF NOT EXISTS actualizado_por TEXT;

CREATE OR REPLACE FUNCTION fn_auditar_contenedor()
RETURNS TRIGGER AS $$
DECLARE
  v_chofer_id UUID;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.estado IS DISTINCT FROM OLD.estado THEN
    v_chofer_id := NULL;
    IF NEW.actualizado_por LIKE 'chofer:%' THEN
      BEGIN
        v_chofer_id := substring(NEW.actualizado_por FROM 8)::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        v_chofer_id := NULL;
      END;
    END IF;
    INSERT INTO historial_contenedores (numero_contenedor, estado, chofer_id, actualizado_por)
    VALUES (NEW.numero, NEW.estado, v_chofer_id, NEW.actualizado_por);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;
