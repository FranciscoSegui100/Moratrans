import { CANTIDAD_DIAS_HABILES_A_OFRECER, HORA_LIMITE_PEDIDO_MISMO_DIA } from '../config/bot.config';

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
 * Próximos días hábiles (lunes a viernes — no se trabaja sábado ni domingo)
 * a partir de mañana. Con `incluirHoy`, si hoy es hábil y todavía no son las
 * HORA_LIMITE_PEDIDO_MISMO_DIA en Mendoza, arranca desde hoy (pedidos del
 * mismo día). No hay feriados cargados todavía: si hace falta excluirlos más
 * adelante, este es el único lugar que hay que tocar.
 *
 * Todo se calcula en hora de Mendoza (UTC-3, sin horario de verano) leyendo
 * con getters UTC sobre el instante corrido 3hs — el proceso de Node corre en
 * UTC en el deploy (ver fechas.service.ts), y con la hora local del server
 * entre las 21hs y medianoche "mañana" ya era pasado mañana.
 */
export function proximosDiasHabiles(
  cantidad: number = CANTIDAD_DIAS_HABILES_A_OFRECER,
  opciones: { incluirHoy?: boolean } = {},
): DiaHabil[] {
  const resultado: DiaHabil[] = [];
  const ahoraMendoza = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const cursor = new Date(Date.UTC(ahoraMendoza.getUTCFullYear(), ahoraMendoza.getUTCMonth(), ahoraMendoza.getUTCDate()));
  const hoyDisponible = !!opciones.incluirHoy && ahoraMendoza.getUTCHours() < HORA_LIMITE_PEDIDO_MISMO_DIA;
  if (!hoyDisponible) cursor.setUTCDate(cursor.getUTCDate() + 1);
  const fechaHoy = !hoyDisponible ? null : cursor.toISOString().slice(0, 10);

  while (resultado.length < cantidad) {
    const dia = cursor.getUTCDay();
    if (dia !== 0 && dia !== 6) {
      const yyyy = cursor.getUTCFullYear();
      const mm = String(cursor.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(cursor.getUTCDate()).padStart(2, '0');
      const fecha = `${yyyy}-${mm}-${dd}`;
      resultado.push({
        fecha,
        etiqueta: `${fecha === fechaHoy ? 'Hoy, ' : ''}${DIAS_SEMANA[dia]} ${dd}/${mm}`,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
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
 *
 * Acepta también un `Date` nativo porque columnas TIMESTAMPTZ (como
 * `contenedores.vence_en`) el driver de pg las devuelve como objeto Date,
 * no como string — a diferencia de las columnas DATE, que sí llegan como
 * string gracias al type-parser custom en config/db.ts.
 */
export function formatearFechaCorta(fecha: string | Date): string {
  let y: string, m: string, d: string;
  if (fecha instanceof Date) {
    // vence_en se guarda como medianoche Argentina (03:00:00Z, ver
    // medianocheArgentina abajo) — restar 3hs y leer en UTC recupera esa
    // fecha sin que la zona horaria del server la corra un día.
    const ajustada = new Date(fecha.getTime() - 3 * 60 * 60 * 1000);
    y = String(ajustada.getUTCFullYear());
    m = String(ajustada.getUTCMonth() + 1).padStart(2, '0');
    d = String(ajustada.getUTCDate()).padStart(2, '0');
  } else {
    [y, m, d] = fecha.slice(0, 10).split('-');
  }
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

/** ¿Es lunes a viernes? `fechaISO` es YYYY-MM-DD (se lee en UTC para no depender de la zona del server). */
export function esDiaHabil(fechaISO: string): boolean {
  const dia = new Date(`${fechaISO.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return dia !== 0 && dia !== 6;
}

/** Esa misma fecha si es hábil; si cae sábado/domingo, el lunes siguiente. */
export function diaHabilDesde(fechaISO: string): string {
  let f = fechaISO.slice(0, 10);
  while (!esDiaHabil(f)) f = sumarDias(f, 1);
  return f;
}

/** Último día hábil ANTERIOR a `fechaISO` (estricto): para un lunes, el viernes. */
export function diaHabilAnterior(fechaISO: string): string {
  let f = sumarDias(fechaISO.slice(0, 10), -1);
  while (!esDiaHabil(f)) f = sumarDias(f, -1);
  return f;
}
