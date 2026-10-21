import { sendButtons } from '../graphApi';

/**
 * Franjas horarias fijas — se pide por botones, no texto libre, para poder
 * agrupar/planificar. Tope 15hs. Títulos cortos a propósito: WhatsApp trunca/
 * rechaza (#131009) los botones de respuesta rápida que pasan los 20 caracteres.
 */
export const OPCIONES_HORARIO = [
  { id: 'horario_manana', title: '🌅 Mañana (8-12hs)' },
  { id: 'horario_tarde', title: '🕐 Tarde (12-15hs)' },
];

export async function pedirHorarioPreferido(to: string, mensaje: string, fechaISO?: string): Promise<void> {
  let opciones = OPCIONES_HORARIO;
  if (fechaISO) {
    const ahoraMendoza = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const hoyISO = ahoraMendoza.toISOString().slice(0, 10);
    if (fechaISO === hoyISO && ahoraMendoza.getUTCHours() >= 12) {
      // Si ya pasó el mediodía en Mendoza y es para hoy, solo queda la franja tarde
      opciones = OPCIONES_HORARIO.filter((o) => o.id === 'horario_tarde');
    }
  }
  await sendButtons(to, mensaje, opciones);
}
