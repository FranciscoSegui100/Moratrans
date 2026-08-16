-- Elimina "en_camino" del flujo del chofer: una entrega ahora pasa
-- directamente de 'reservado' a 'entregado' (el chofer ya no marca "voy en
-- camino" como paso aparte, ver chofer.flow.ts). El valor 'en_camino' del
-- enum estado_contenedor NO se puede borrar sin recrear el tipo entero (y
-- rompería historial_contenedores, que guarda estados viejos tal cual) —
-- queda definido pero sin ningún camino nuevo que lo alcance.
CREATE OR REPLACE FUNCTION fn_validar_transicion_contenedor()
RETURNS TRIGGER AS $$
DECLARE
  permitido BOOLEAN := FALSE;
BEGIN
  IF NEW.estado = OLD.estado THEN
    RETURN NEW; -- sin cambio de estado
  END IF;

  permitido := CASE OLD.estado
    WHEN 'disponible'    THEN NEW.estado IN ('reservado','mantenimiento')
    WHEN 'reservado'     THEN NEW.estado IN ('entregado','disponible')     -- se libera si se cancela
    -- Compat: si algún contenedor quedó "en_camino" de antes de esta
    -- migración, todavía puede salir de ahí (ver UPDATE más abajo, que ya
    -- los saca a todos) — ningún flujo nuevo vuelve a dejar un contenedor acá.
    WHEN 'en_camino'     THEN NEW.estado IN ('entregado')
    WHEN 'entregado'     THEN NEW.estado IN ('retirado')
    WHEN 'retirado'      THEN NEW.estado IN ('disponible','mantenimiento')
    WHEN 'mantenimiento' THEN NEW.estado IN ('disponible')
    ELSE FALSE
  END;

  IF NOT permitido THEN
    RAISE EXCEPTION 'Transición de contenedor inválida: % -> %', OLD.estado, NEW.estado
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

-- Cualquier contenedor que en este momento esté "en_camino" pasa directo a
-- 'entregado' — ya no queda ningún botón del chofer que lo pueda sacar de
-- ahí de otra forma, así que no puede quedar huérfano en ese estado.
UPDATE contenedores SET estado = 'entregado', actualizado_por = 'sistema:migracion_0019'
 WHERE estado = 'en_camino';
