/**
 * Helpers de fechas de viajes compartidos por el panel.
 */

/**
 * Hoy en formato YYYY-MM-DD, en hora local (NO toISOString(): eso da la fecha
 * en UTC, y entre ~21hs y medianoche hora Mendoza ya "es mañana" en UTC).
 */
export function hoyISO(): string {
  const hoy = new Date();
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const dd = String(hoy.getDate()).padStart(2, '0');
  return `${hoy.getFullYear()}-${mm}-${dd}`;
}

/** Suma (o resta, con negativo) días a una fecha YYYY-MM-DD y la devuelve YYYY-MM-DD. */
export function sumarDias(fechaISO: string, dias: number): string {
  const [a, m, d] = fechaISO.slice(0, 10).split('-').map(Number);
  const fecha = new Date(a, m - 1, d);
  fecha.setDate(fecha.getDate() + dias);
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  return `${fecha.getFullYear()}-${mm}-${dd}`;
}

/** ¿`fecha` (YYYY-MM-DD, o ISO larga) cae dentro de [desde, hasta] inclusive? Comparación de strings ISO. */
export function fechaEnRango(fecha: string, desde: string, hasta: string): boolean {
  const f = fecha.slice(0, 10);
  return f >= desde && f <= hasta;
}
