-- El chofer ahora recibe el pedido de vaciado como una parada más de la
-- secuencia de la ruta (entre el retiro y la próxima parada), no como un
-- recordatorio aparte que tenía que ir a buscar solo con el menú "🗑️".
-- Esta columna evita reenviarle el mismo aviso dos veces — mismo criterio
-- que viajes.chofer_notificado_en (ver migración 0054_chofer_notificado.sql).
ALTER TABLE ruta_vaciados ADD COLUMN IF NOT EXISTS chofer_notificado_en TIMESTAMPTZ;
