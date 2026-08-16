-- El cliente puede llenar el contenedor antes de lo previsto y pedir que lo
-- retiren sin esperar una fecha ya programada (ver pedirRetiro.flow.ts).
-- Aparte de 'cancelar retiro' (retiro ya programado que el cliente no
-- quiere), hace falta el caso inverso: pedir uno nuevo o adelantar el que
-- ya había. Igual que en la migración 0012, ADD VALUE va solo en su propia
-- transacción/archivo.
ALTER TYPE tipo_alerta ADD VALUE 'retiro_solicitado';
