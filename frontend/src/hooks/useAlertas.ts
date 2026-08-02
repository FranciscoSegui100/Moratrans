import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';

export interface Alerta {
  id: string;
  tipo: string;
  referencia_id: string;
  mensaje: string;
  estado: string;
  creado_en: string;
}

/** Carga las alertas abiertas y las mantiene actualizadas por Socket.io. */
export function useAlertas() {
  const [alertas, setAlertas] = useState<Alerta[]>([]);

  useEffect(() => {
    api.get<Alerta[]>('/api/alertas').then((r) => setAlertas(r.data)).catch(() => {});

    const socket = conectarSocket();
    socket.on('nueva_alerta', (a: Alerta) => {
      setAlertas((prev) => (prev.find((x) => x.id === a.id) ? prev : [a, ...prev]));
    });
    return () => { socket.off('nueva_alerta'); };
  }, []);

  async function resolver(id: string) {
    await api.patch(`/api/alertas/${id}`, { estado: 'resuelta' });
    setAlertas((prev) => prev.filter((a) => a.id !== id));
  }

  return { alertas, resolver };
}
