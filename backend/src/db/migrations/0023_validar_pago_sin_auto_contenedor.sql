-- 0023_validar_pago_sin_auto_contenedor.sql
-- Al validar un pago en el panel (fn_validar_pago), si el operador NO especificó
-- un contenedor explícito (p_contenedor_numero IS NULL), la función ya NO
-- auto-selecciona el primer contenedor disponible ni lo pasa a 'reservado'.
-- El pedido se confirma, se crea el ticket (con contenedor_numero = NULL) y el viaje
-- entra a la bolsa de pedidos sin rutear para que se le asigne contenedor y chofer
-- al armar la ruta.

CREATE OR REPLACE FUNCTION fn_validar_pago(
  p_pago_id           UUID,
  p_usuario_id        UUID,
  p_contenedor_numero TEXT DEFAULT NULL
) RETURNS TABLE (ticket_id UUID, contenedor TEXT, reservado_ahora BOOLEAN) AS $$
DECLARE
  v_pedido_id      UUID;
  v_cont           TEXT := NULL;
  v_estado_actual  estado_contenedor;
  v_vence          TIMESTAMPTZ;
  v_ticket         UUID;
  v_reservar_ahora BOOLEAN := FALSE;
BEGIN
  -- 1. Bloquear el pago y validar estado
  UPDATE pagos
     SET estado = 'validado', validado_por = p_usuario_id
   WHERE id = p_pago_id AND estado = 'pendiente'
   RETURNING pedido_id INTO v_pedido_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pago inexistente o no está pendiente' USING ERRCODE = 'no_data_found';
  END IF;

  -- 2. Tomar el contenedor solo si se especificó uno
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
    ELSE
      v_reservar_ahora := TRUE;
    END IF;
  ELSE
    -- No se especificó contenedor: queda como NULL para asignarse en la bolsa/ruta
    v_cont := NULL;
    v_reservar_ahora := FALSE;
  END IF;

  -- 3. Reservar el contenedor ahora solo si se especificó y está disponible
  IF v_reservar_ahora AND v_cont IS NOT NULL THEN
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
   WHERE tipo IN ('pago_pendiente_validacion', 'cuenta_corriente_solicitada')
     AND referencia_id = p_pago_id::text;

  RETURN QUERY SELECT v_ticket, v_cont, v_reservar_ahora;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;
