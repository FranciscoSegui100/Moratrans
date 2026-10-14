-- Alerta para contenedores que ya pasaron su fecha de vencimiento y siguen
-- con el cliente sin retiro programado (ver jobs/alertas.cron.ts). Antes solo
-- existía 'contenedor_por_vencer' (próximas 48h): una vez pasada la fecha, el
-- contenedor dejaba de generar cualquier aviso.
-- ADD VALUE va solo en su propia transacción/archivo (igual que 0047).
ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'contenedor_vencido';
