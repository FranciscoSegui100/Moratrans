import { CANTIDAD_DIAS_HABILES_A_OFRECER } from '../config/bot.config';

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export interface DiaHabil {
  /** YYYY-MM-DD, para guardar en DB. */
  fecha: string;
  /** "lunes 24/08", para mostrarle al cliente. */
  etiqueta: string;
}

/**
 * Próximos días hábiles (lunes a sábado — el único día que se excluye es
 * domingo, como pidió el dueño explícitamente) a partir de mañana. No hay
 * feriados cargados todavía: si hace falta excluirlos más adelante, este es
 * el único lugar que hay que tocar.
 */
export function proximosDiasHabiles(cantidad: number = CANTIDAD_DIAS_HABILES_A_OFRECER): DiaHabil[] {
  const resultado: DiaHabil[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1); // arranca mañana, no hoy

  while (resultado.length < cantidad) {
    if (cursor.getDay() !== 0) {
      const yyyy = cursor.getFullYear();
      const mm = String(cursor.getMonth() + 1).padStart(2, '0');
      const dd = String(cursor.getDate()).padStart(2, '0');
      resultado.push({
        fecha: `${yyyy}-${mm}-${dd}`,
        etiqueta: `${DIAS_SEMANA[cursor.getDay()]} ${dd}/${mm}`,
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return resultado;
}

/** "lunes 24 de agosto" — usado en confirmaciones de texto libre. */
export function formatearFechaLarga(fechaISO: string): string {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const fecha = new Date(y, m - 1, d);
  return `${DIAS_SEMANA[fecha.getDay()]} ${d} de ${MESES[m - 1]}`;
}

/**
 * "28/08/2026" — para mensajes cortos (WhatsApp, errores). A diferencia de
 * `new Date(fechaISO).toLocaleDateString('es-AR')`, no pasa por UTC: esa
 * conversión interpreta "2026-08-28" como medianoche UTC y, en horario
 * Argentina (UTC-3), lo muestra retrocedido un día.
 */
export function formatearFechaCorta(fechaISO: string): string {
  const [y, m, d] = fechaISO.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Instante UTC de la medianoche de `fechaISO` en Argentina (formato ISO,
 * listo para bindear a una columna TIMESTAMPTZ como contenedores.vence_en).
 * Argentina no tiene horario de verano — está fija en UTC-3 todo el año —
 * así que sumar 3 horas siempre da el resultado correcto, sin necesitar
 * tablas de zonas horarias.
 *
 * Sin esto, escribir `vence_en = $1::date` (o bindear el string pelado
 * directo) hace que Postgres interprete la fecha como medianoche UTC —
 * en horario argentino eso se ve como las 21hs del día ANTERIOR (ver
 * formatearFechaCorta arriba, mismo bug de raíz pero al guardar en vez de
 * al mostrar).
 */
export function medianocheArgentina(fechaISO: string): string {
  return `${fechaISO.slice(0, 10)}T03:00:00.000Z`;
}

/** Suma `dias` días de calendario (no hábiles) a una fecha ISO. Usado para fecha_retiro_estimada. */
export function sumarDias(fechaISO: string, dias: number): string {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const fecha = new Date(y, m - 1, d);
  fecha.setDate(fecha.getDate() + dias);
  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
