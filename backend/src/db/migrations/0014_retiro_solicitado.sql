-- El cliente puede llenar el contenedor antes de lo previsto y pedir que lo
-- retiren sin esperar una fecha ya programada (ver pedirRetiro.flow.ts):
-- pide uno nuevo o adelanta el que ya había. Igual que en la migración 0012,
-- ADD VALUE va solo en su propia transacción/archivo.
ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'retiro_solicitado';
