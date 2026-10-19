/**
 * Hoy en Mendoza (UTC-3, sin horario de verano) como YYYY-MM-DD, sin confiar
 * en la zona horaria del proceso de Node ni en CURRENT_DATE/now() de
 * Postgres — ambos corren en UTC en este deploy, así que cualquiera de los
 * dos daría "mañana" entre las ~21hs y medianoche hora local.
 */
export function hoyMendozaISO(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
