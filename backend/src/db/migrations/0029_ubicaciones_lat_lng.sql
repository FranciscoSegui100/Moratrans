-- Coordenadas de depósitos/vaciaderos propios, opcional (NULL = sin cargar
-- todavía). Se usan para calcular la distancia cuando un cliente comparte
-- una ubicación fuera de todas las zonas de cobertura (ver
-- geoDepartamento.service.ts::distanciaALaBaseMasCercana), para poder
-- avisarle qué tan lejos está antes de derivarlo a un asesor.
ALTER TABLE ubicaciones ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6);
ALTER TABLE ubicaciones ADD COLUMN IF NOT EXISTS lng NUMERIC(9,6);
