const VENTANA_MS = 24 * 60 * 60 * 1000;

export interface VentanaWhatsapp {
  /** null = todavía no le conocemos ningún mensaje al cliente. */
  minutosRestantes: number | null;
  cerrada: boolean;
  /** 0-100, para la barra. */
  porcentaje: number;
}

/** Ventana de 24hs de WhatsApp: pasado ese lapso desde el último mensaje del
 * cliente, ya no se le puede mandar texto libre (solo una plantilla aprobada). */
export function calcularVentana(ultimoClienteEn: string | null, ahora = Date.now()): VentanaWhatsapp {
  if (!ultimoClienteEn) return { minutosRestantes: null, cerrada: false, porcentaje: 0 };
  const vence = new Date(ultimoClienteEn).getTime() + VENTANA_MS;
  const restanteMs = vence - ahora;
  const minutosRestantes = Math.max(0, Math.round(restanteMs / 60000));
  const porcentaje = Math.min(100, Math.max(0, (restanteMs / VENTANA_MS) * 100));
  return { minutosRestantes, cerrada: restanteMs <= 0, porcentaje };
}

export function formatVentana({ minutosRestantes, cerrada }: VentanaWhatsapp): string {
  if (cerrada) return 'Ventana cerrada';
  if (minutosRestantes === null) return 'Sin mensajes del cliente';
  const h = Math.floor(minutosRestantes / 60);
  const m = minutosRestantes % 60;
  return `${h}h ${m}m restantes`;
}
