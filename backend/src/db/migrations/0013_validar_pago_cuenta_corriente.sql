-- Los pagos a cuenta corriente (ver pago.flow.ts) levantan la alerta
-- 'cuenta_corriente_solicitada' en vez de 'pago_pendiente_validacion' (no hay
-- comprobante que revisar, es una decisión de confianza distinta) — pero
-- ambas comparten referencia_id = pago.id, así que fn_validar_pago tiene que
-- resolver la que corresponda. No se toca la firma (mismo RETURNS TABLE que
-- 0009), CREATE OR REPLACE alcanza.
CREATE OR REPLACE FUNCTION fn_validar_pago(
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

  -- 6. Resolver la alerta de pago pendiente si existía (transferencia o cuenta corriente)
  UPDATE alertas SET estado = 'resuelta'
   WHERE tipo IN ('pago_pendiente_validacion', 'cuenta_corriente_solicitada')
     AND referencia_id = p_pago_id::text;

  RETURN QUERY SELECT v_ticket, v_cont, v_reservar_ahora;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;
