-- Cuando un cliente comparte su ubicación GPS en vivo por WhatsApp (no una
-- dirección escrita), Meta casi nunca manda una dirección de texto junto con
-- las coordenadas — hasta ahora esas coordenadas se guardaban en `pedidos`
-- pero se perdían al pasar a `viajes` (esta tabla no las tenía), así que el
-- panel logístico no podía ni mostrar una dirección legible ni linkear a
-- Google Maps. Ver geocoding.service.ts (reverseGeocode) y GET /api/viajes.
ALTER TABLE viajes ADD COLUMN destino_lat NUMERIC(9,6);
ALTER TABLE viajes ADD COLUMN destino_lng NUMERIC(9,6);
