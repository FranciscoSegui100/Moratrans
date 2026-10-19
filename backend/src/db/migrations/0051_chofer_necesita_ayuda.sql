-- Agrega el tipo de alerta 'chofer_necesita_ayuda': un chofer RECONOCIDO
-- (su teléfono sí matchea, a diferencia de 'chofer_no_reconocido') que no
-- logra avanzar en el bot tras varios mensajes sin entender — el chofer
-- queda sin ninguna salida a una persona, igual que tenía el cliente antes
-- de manejarRespuestaInvalida + "Hablar con asesor".
ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'chofer_necesita_ayuda';
