-- Vuelve el selector de departamento al principio del flujo de cotización/
-- entrega/recambio (ver cotizacion.flow.ts, pedirEntrega.flow.ts,
-- recambio.flow.ts): además del pin (siempre prioritario), ahora se puede
-- escribir calle y número del departamento ya elegido sin buscarlo en el
-- mapa — se guarda tal cual lo escribe el cliente, para que una persona lo
-- verifique manualmente antes de despachar. `direccion_verificada = false`
-- marca esos casos.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS direccion_verificada BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE viajes  ADD COLUMN IF NOT EXISTS direccion_verificada BOOLEAN NOT NULL DEFAULT TRUE;

-- ALTER TYPE ... ADD VALUE no se puede usar en la misma transacción en la
-- que se agrega — como esta migración no inserta ni filtra por el valor
-- nuevo, se puede agregar junto con lo demás (migrate.ts corre cada archivo
-- en su propia transacción, ver migraciones 0012/0014/0024).
ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'direccion_sin_verificar';
