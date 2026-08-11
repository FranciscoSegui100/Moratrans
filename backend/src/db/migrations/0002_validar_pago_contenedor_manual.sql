-- Permite elegir a mano qué contenedor específico se reserva al validar un
-- pago (antes siempre tomaba el primero disponible sin poder elegir). Si no
-- se pasa p_contenedor_numero, se comporta exactamente igual que antes.
CREATE OR REPLACE FUNCTION fn_validar_pago(
  p_pago_id           UUID,
  p_usuario_id        UUID,
  p_contenedor_numero TEXT DEFAULT NULL
) RETURNS TABLE (ticket_id UUID, contenedor TEXT) AS $$
DECLARE
  v_pedido_id UUID;
  v_cont      TEXT;
  v_ticket    UUID;
BEGIN
  -- 1. Bloquear el pago y validar estado
  UPDATE pagos
     SET estado = 'validado', validado_por = p_usuario_id
   WHERE id = p_pago_id AND estado = 'pendiente'
   RETURNING pedido_id INTO v_pedido_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pago inexistente o no está pendiente' USING ERRCODE = 'no_data_found';
  END IF;

  -- 2. Tomar el contenedor: el elegido a mano (si lo pasaron y está
  --    disponible) o el primero disponible (con lock de fila) como antes.
  IF p_contenedor_numero IS NOT NULL THEN
    SELECT numero INTO v_cont
      FROM contenedores
     WHERE numero = p_contenedor_numero AND estado = 'disponible'
     FOR UPDATE SKIP LOCKED;

    IF v_cont IS NULL THEN
      RAISE EXCEPTION 'El contenedor % no está disponible', p_contenedor_numero
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
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

  -- 3. Reservar el contenedor (dispara triggers de historial)
  UPDATE contenedores
     SET estado = 'reservado', actualizado_por = 'validacion_pago'
   WHERE numero = v_cont;

  -- 4. Avanzar el pedido
  UPDATE pedidos SET estado = 'confirmado' WHERE id = v_pedido_id;

  -- 5. Crear el ticket
  INSERT INTO tickets (pedido_id, pago_id, contenedor_numero)
  VALUES (v_pedido_id, p_pago_id, v_cont)
  RETURNING id INTO v_ticket;

  -- 6. Resolver la alerta de pago pendiente si existía
  UPDATE alertas SET estado = 'resuelta'
   WHERE tipo = 'pago_pendiente_validacion' AND referencia_id = p_pago_id::text;

  RETURN QUERY SELECT v_ticket, v_cont;
END;
$$ LANGUAGE plpgsql;
