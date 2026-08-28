-- Elimina una sobrecarga huérfana de fn_validar_pago que quedó viva en la base
-- desde el bootstrap original (anterior a la migración 0002). Firma de 2 args
-- fn_validar_pago(p_pago_id uuid, p_usuario_id uuid): devuelve la tabla vieja
-- (ticket_id, contenedor) sin `reservado_ahora` y todavía autoelige "el primer
-- contenedor disponible" — el comportamiento que la migración 0023 quitó a
-- propósito. Ni las migraciones ni seed.sql la definen y ningún call site la
-- usa: todas las llamadas pasan 3 argumentos y resuelven a la versión buena
-- fn_validar_pago(uuid, uuid, text). Sin dependencias (vistas/funciones/triggers).
DROP FUNCTION IF EXISTS public.fn_validar_pago(uuid, uuid);
