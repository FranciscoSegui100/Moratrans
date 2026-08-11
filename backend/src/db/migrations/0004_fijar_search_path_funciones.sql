-- Fija el search_path de las funciones: sin esto, Postgres las resuelve
-- contra el search_path de quien las llama, lo que permite "search_path
-- hijacking" (un schema creado por otro rol, antes que public en el
-- search_path, podría shadowear las tablas que usan sin calificar).
ALTER FUNCTION fn_validar_transicion_contenedor() SET search_path = public, pg_temp;
ALTER FUNCTION fn_auditar_contenedor()             SET search_path = public, pg_temp;
ALTER FUNCTION fn_touch_actualizado()              SET search_path = public, pg_temp;
ALTER FUNCTION fn_validar_pago(uuid, uuid, text)   SET search_path = public, pg_temp;
