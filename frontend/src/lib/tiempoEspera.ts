export type NivelEspera = 'verde' | 'ambar' | 'rojo';

export interface TiempoEspera {
  /** null = no hay desde cuándo calcular (nada pendiente). */
  minutos: number | null;
  nivel: NivelEspera;
  texto: string;
}

const CORTE_AMBAR_MIN = 5;
const CORTE_ROJO_MIN = 15;

/**
 * Tiempo transcurrido desde que una conversación quedó esperando a un
 * humano (escalado_en) o desde que un operador la tomó (asignado_en), con
 * el mismo código semáforo que usan las colas de soporte tipo
 * Intercom/Zendesk: verde < 5min, ámbar 5-15min, rojo > 15min.
 */
export function calcularTiempoEspera(desde: string | null, ahora = Date.now()): TiempoEspera {
  if (!desde) return { minutos: null, nivel: 'verde', texto: '' };
  const minutos = Math.max(0, Math.floor((ahora - new Date(desde).getTime()) / 60000));
  const nivel: NivelEspera = minutos >= CORTE_ROJO_MIN ? 'rojo' : minutos >= CORTE_AMBAR_MIN ? 'ambar' : 'verde';
  const texto = minutos < 1 ? 'hace instantes' : minutos === 1 ? 'hace 1 min' : `hace ${minutos} min`;
  return { minutos, nivel, texto };
}
