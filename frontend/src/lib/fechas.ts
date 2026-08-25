/**
 * Utilidades para formateo consistente y limpio de fechas en la aplicación (es-AR).
 * Evita desfasajes horarios al procesar fechas de tipo calendario (DATE/YYYY-MM-DD).
 */

export function formatearFecha(fecha?: string | Date | null): string {
  if (!fecha) return '—';

  if (typeof fecha === 'string') {
    // Si viene en formato ISO (ej: "2026-08-27T00:00:00.000Z") o estándar ("2026-08-27")
    const match = fecha.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [, anio, mes, dia] = match;
      return `${dia}/${mes}/${anio}`;
    }
  }

  const d = typeof fecha === 'string' ? new Date(fecha) : fecha;
  if (isNaN(d.getTime())) return String(fecha);

  return d.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatearFechaHora(fecha?: string | Date | null): string {
  if (!fecha) return '—';
  const d = typeof fecha === 'string' ? new Date(fecha) : fecha;
  if (isNaN(d.getTime())) return String(fecha);

  return d.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatearFechaCorta(fecha?: string | Date | null): string {
  if (!fecha) return '—';

  if (typeof fecha === 'string') {
    const match = fecha.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [, , mes, dia] = match;
      return `${dia}/${mes}`;
    }
  }

  const d = typeof fecha === 'string' ? new Date(fecha) : fecha;
  if (isNaN(d.getTime())) return String(fecha);

  return d.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
  });
}
