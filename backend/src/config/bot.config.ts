/**
 * Configuración del chatbot de WhatsApp que NO depende de una zona
 * particular (los precios y polígonos de zona siguen editándose desde el
 * panel, tabla tarifas_departamento). Todo lo que esté acá se puede tocar
 * sin tocar la lógica de ningún flujo.
 */

/** Respuestas inválidas seguidas antes de ofrecerle al cliente hablar con un asesor. */
export const LIMITE_INTENTOS_INVALIDOS = 2;

/** Veces que el cliente tiene que pedir "asesor" espontáneamente antes de escalar. */
export const INTENTOS_PARA_ESCALAR_ASESOR = 3;

/** Días de alquiler antes de que corresponda el retiro (se cuentan desde la entrega o el recambio). */
export const DIAS_ALQUILER_ANTES_RETIRO = 7;

/** Cantidad de próximos días hábiles (lunes a sábado) que se le ofrecen al cliente para elegir. */
export const CANTIDAD_DIAS_HABILES_A_OFRECER = 6;

/** Días que suma "extender el retiro". Solo se puede aplicar una vez por ciclo (ver alargarRetiro.flow.ts). */
export const DIAS_ALARGUE = 5;

/** El alargue cuesta esta fracción de la tarifa vigente de la zona del contenedor (ver alargarRetiro.flow.ts). */
export const PORCENTAJE_ALARGUE = 0.5;

/** Próximos días hábiles que se le ofrecen para un retiro anticipado (no puede superar la fecha de retiro ya pactada). */
export const DIAS_A_OFRECER_RETIRO_ANTICIPADO = 3;

/** Tipos de lugar que se le preguntan al cliente tras confirmar la ubicación (caso borde "datos que el GPS no da"). */
export const TIPOS_LUGAR: { id: string; title: string }[] = [
  { id: 'lugar_casa', title: '🏠 Casa' },
  { id: 'lugar_obra', title: '🏗️ Obra' },
  { id: 'lugar_comercio', title: '🏪 Comercio' },
  { id: 'lugar_consorcio', title: '🏢 Consorcio' },
];

/**
 * Franja horaria única para entregas en barrios privados: el acceso suele
 * estar restringido por el propio barrio, así que no se le ofrece el
 * selector normal de Mañana/Tarde — placeholder fácil de ajustar acá.
 */
export const HORARIO_BARRIO_PRIVADO = { id: 'horario_barrio_privado', title: '🕐 9 a 17hs' };

/** Radio (grados, aprox.) alrededor de Mendoza capital para priorizar resultados de geocodificación de direcciones escritas. */
export const VIEWBOX_MENDOZA = { minLon: -69.3, minLat: -33.3, maxLon: -68.4, maxLat: -32.4 };
