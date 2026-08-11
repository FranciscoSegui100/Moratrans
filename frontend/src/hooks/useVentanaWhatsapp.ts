import { useEffect, useState } from 'react';
import { calcularVentana, VentanaWhatsapp } from '../lib/ventanaWhatsapp';

/** Recalcula la ventana de 24hs cada minuto, para que la barra/el texto se
 * muevan solos mientras el operador tiene la conversación abierta. */
export function useVentanaWhatsapp(ultimoClienteEn: string | null): VentanaWhatsapp {
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setAhora(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  return calcularVentana(ultimoClienteEn, ahora);
}
