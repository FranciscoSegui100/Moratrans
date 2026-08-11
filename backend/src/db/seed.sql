-- =====================================================================
--  SEED de datos iniciales + función de validación de pago (atómica)
-- =====================================================================
BEGIN;

-- Tarifas (el bot SIEMPRE lee de aquí; nada hardcodeado).
-- Departamentos del Gran Mendoza. Precios de referencia — ajustalos desde
-- el panel (Tarifas), son solo un punto de partida.
INSERT INTO tarifas_departamento (departamento, precio, moneda) VALUES
  ('Capital',        8000.00, 'ARS'),
  ('Godoy Cruz',      8500.00, 'ARS'),
  ('Guaymallén',      9000.00, 'ARS'),
  ('Las Heras',       9500.00, 'ARS'),
  ('Luján de Cuyo',  11000.00, 'ARS'),
  ('Maipú',          10000.00, 'ARS')
ON CONFLICT (departamento) DO NOTHING;

-- Usuario admin inicial. El hash corresponde a "Moratrans2026!" (bcrypt).
-- Cámbialo en producción; nunca guardes credenciales en el repo.
INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES
  ('Administrador', 'admin@empresa.com',
   '$2a$10$WfVk5Som.phoggqcdqKZteO0mpT3MOzl4d9pbXp2v5yjbb3uPhRDq', 'admin')
ON CONFLICT (email) DO NOTHING;

-- NOTA: los contenedores NO se siembran acá a propósito — se cargan desde
-- el panel (página Contenedores). Las alertas tampoco se siembran: las
-- genera el sistema solo (cron + eventos reales).

-- NOTA: los choferes NO se insertan aquí porque el DNI se cifra en la app.
-- Cargá el chofer inicial con:  npm run db:seed-choferes
-- (ver backend/src/db/seedChoferes.ts)

COMMIT;

-- ---------------------------------------------------------------------
-- Función atómica: validar pago -> reservar contenedor -> crear ticket
-- Se llama desde el panel (POST /api/pagos/:id/validar).
-- Devuelve el ticket creado. Si no hay contenedor libre, hace ROLLBACK
-- implícito vía EXCEPTION.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_validar_pago(
  p_pago_id     UUID,
  p_usuario_id  UUID
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

  -- 2. Tomar el primer contenedor disponible (con lock de fila)
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
