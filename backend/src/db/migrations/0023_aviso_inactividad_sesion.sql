-- Cierre proactivo de chats inactivos: antes había un TTL pasivo (se
-- descartaba la sesión recién cuando el cliente volvía a escribir). Ahora un
-- cron avisa a los 5 min de inactividad y cierra la conversación a los 5 min
-- de ese aviso (10 min totales) si el cliente no respondió. Este campo marca
-- cuándo se mandó el aviso, para no repetirlo y para saber cuándo cerrar.
ALTER TABLE sesiones_chat ADD COLUMN IF NOT EXISTS avisado_en TIMESTAMPTZ;
