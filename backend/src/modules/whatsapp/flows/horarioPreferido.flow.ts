import { sendButtons } from '../graphApi';

/**
 * Franjas horarias fijas — se pide por botones, no texto libre, para poder
 * agrupar/planificar. Tope 15hs. Títulos cortos a propósito: WhatsApp trunca/
 * rechaza (#131009) los botones de respuesta rápida que pasan los 20 caracteres.
 */
export const OPCIONES_HORARIO = [
  { id: 'horario_manana', title: '🌅 Mañana (8-12hs)' },
  { id: 'horario_mediodia', title: '🕐 Tarde (12-15hs)' },
];

export function tituloHorario(id: string | null | undefined): string | null {
  return OPCIONES_HORARIO.find((o) => o.id === id)?.title ?? null;
}

export async function pedirHorarioPreferido(to: string, mensaje: string): Promise<void> {
  await sendButtons(to, mensaje, OPCIONES_HORARIO);
}
