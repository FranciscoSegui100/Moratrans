-- Contador genérico de "el cliente contestó algo que no corresponde a este
-- estado" — antes cada flow manejaba esto a mano y sin límite (repetía el
-- mismo mensaje para siempre). Ahora el dispatcher central
-- (ver estados.ts::manejarRespuestaInvalida) lo incrementa en cualquier
-- estado ante una respuesta inválida, y lo resetea a 0 en cualquier
-- transición válida (ver session.store.ts::setSesion). A partir del 2do
-- intento inválido seguido, se le ofrece explícitamente hablar con un
-- asesor en vez de repetir el mensaje una tercera vez.
ALTER TABLE sesiones_chat ADD COLUMN IF NOT EXISTS intentos_invalidos INT NOT NULL DEFAULT 0;
