import { useEffect, useState } from 'react';
import { calcularTiempoEspera, TiempoEspera } from '../lib/tiempoEspera';

/** Recalcula el tiempo de espera cada 30s, para que el chip de color se mueva solo mientras el operador mira la lista. */
export function useTiempoEspera(desde: string | null): TiempoEspera {
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setAhora(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  return calcularTiempoEspera(desde, ahora);
}
