-- MoraTrans siempre cotiza y cobra en pesos argentinos: la columna moneda
-- de tarifas_departamento era 100% 'ARS' en la práctica y solo agregaba un
-- campo más para mantener en el alta/edición de tarifas. Se saca de la
-- tabla; todo lugar que mostraba el monto con esa moneda ahora usa el
-- literal fijo 'ARS' (ver formatearMonto en pdf.service.ts).
ALTER TABLE tarifas_departamento DROP COLUMN moneda;
