-- Permite validar un pago eligiendo un contenedor que todavía está ocupado
-- (con otro cliente), siempre que tenga vence_en cargado y nadie más lo haya
-- reservado ya para otra entrega futura. El pago se valida y el ticket se
-- crea igual, pero el contenedor NO pasa a 'reservado' todavía: sigue en su
-- estado actual hasta que vuelva de verdad (ver POST
-- /api/contenedores/:numero/confirmar-retiro, que lo pasa a 'reservado' en
-- ese momento). Se agrega la columna reservado_ahora al resultado para que
-- el backend sepa si tiene que avisarle al chofer ya mismo o recién cuando
-- el contenedor vuelva.
--
-- CREATE OR REPLACE no permite cambiar las columnas de un RETURNS TABLE
-- existente (Postgres lo rechaza como cambio de tipo de retorno) — hay que
-- dropearla primero.
DROP FUNCTION IF EXISTS fn_validar_pago(UUID, UUID, TEXT);

CREATE FUNCTION fn_validar_pago(
  p_pago_id           UUID,
  p_usuario_id        UUID,
  p_contenedor_numero TEXT DEFAULT NULL
) RETURNS TABLE (ticket_id UUID, contenedor TEXT, reservado_ahora BOOLEAN) AS $$
DECLARE
  v_pedido_id      UUID;
  v_cont           TEXT;
  v_estado_actual  estado_contenedor;
  v_vence          TIMESTAMPTZ;
  v_ticket         UUID;
  v_reservar_ahora BOOLEAN := TRUE;
BEGIN
  -- 1. Bloquear el pago y validar estado
  UPDATE pagos
     SET estado = 'validado', validado_por = p_usuario_id
   WHERE id = p_pago_id AND estado = 'pendiente'
   RETURNING pedido_id INTO v_pedido_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pago inexistente o no está pendiente' USING ERRCODE = 'no_data_found';
  END IF;

  -- 2. Tomar el contenedor
  IF p_contenedor_numero IS NOT NULL THEN
    SELECT numero, estado, vence_en INTO v_cont, v_estado_actual, v_vence
      FROM contenedores
     WHERE numero = p_contenedor_numero
     FOR UPDATE;

    IF v_cont IS NULL THEN
      RAISE EXCEPTION 'El contenedor % no existe', p_contenedor_numero
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_estado_actual <> 'disponible' THEN
      -- Ocupado: se puede reservar a futuro solo si tiene fecha de vuelta y
      -- nadie más ya lo está esperando (mismo criterio que POST /api/viajes).
      IF v_vence IS NULL THEN
        RAISE EXCEPTION 'El contenedor % está % y no tiene fecha de vuelta cargada; no se puede reservar a futuro', p_contenedor_numero, v_estado_actual
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM viajes
         WHERE contenedor_numero = p_contenedor_numero AND tipo = 'entrega' AND estado IN ('programado', 'en_curso')
      ) THEN
        RAISE EXCEPTION 'El contenedor % ya tiene una entrega reservada (actual o futura)', p_contenedor_numero
          USING ERRCODE = 'check_violation';
      END IF;
      v_reservar_ahora := FALSE;
    END IF;
  ELSE
    -- Automático: siempre el primero disponible ahora mismo (no se auto-asignan ocupados).
    SELECT numero INTO v_cont
      FROM contenedores
     WHERE estado = 'disponible'
     ORDER BY creado_en
     FOR UPDATE SKIP LOCKED
     LIMIT 1;

    IF v_cont IS NULL THEN
      RAISE EXCEPTION 'No hay contenedores disponibles para reservar'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 3. Reservar el contenedor ahora, solo si ya está disponible (dispara triggers de historial)
  IF v_reservar_ahora THEN
    UPDATE contenedores
       SET estado = 'reservado', actualizado_por = 'validacion_pago'
     WHERE numero = v_cont;
  END IF;

  -- 4. Avanzar el pedido
  UPDATE pedidos SET estado = 'confirmado' WHERE id = v_pedido_id;

  -- 5. Crear el ticket
  INSERT INTO tickets (pedido_id, pago_id, contenedor_numero)
  VALUES (v_pedido_id, p_pago_id, v_cont)
  RETURNING id INTO v_ticket;

  -- 6. Resolver la alerta de pago pendiente si existía
  UPDATE alertas SET estado = 'resuelta'
   WHERE tipo = 'pago_pendiente_validacion' AND referencia_id = p_pago_id::text;

  RETURN QUERY SELECT v_ticket, v_cont, v_reservar_ahora;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;
