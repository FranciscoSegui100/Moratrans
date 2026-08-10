import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';

export interface Conversacion {
  telefono: string;
  ultimo_mensaje: string;
  ultimo_origen: 'cliente' | 'bot' | 'operador';
  ultimo_en: string;
  modo_humano: boolean;
}

interface MensajeChatSocket {
  telefono: string;
  texto: string;
  origen: Conversacion['ultimo_origen'];
  creado_en: string;
}

const CONVERSACIONES_KEY = ['conversaciones'];

/** Carga TODAS las conversaciones (no solo las escaladas a "asesor") y las mantiene al día por Socket.io. */
export function useConversaciones() {
  const queryClient = useQueryClient();
  const { data: conversaciones = [] } = useQuery<Conversacion[]>({
    queryKey: CONVERSACIONES_KEY,
    queryFn: () => api.get<Conversacion[]>('/api/chat').then((r) => r.data),
  });

  useEffect(() => {
    const socket = conectarSocket();
    const resincronizar = () => queryClient.invalidateQueries({ queryKey: CONVERSACIONES_KEY });
    socket.on('connect', resincronizar);
    // Cualquier mensaje nuevo (de cualquier conversación) sube esa fila al
    // tope de la lista, igual que haría WhatsApp/el chat de un CRM.
    const onNuevoMensaje = (m: MensajeChatSocket) => {
      queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) => {
        const actual = prev.find((c) => c.telefono === m.telefono);
        const resto = prev.filter((c) => c.telefono !== m.telefono);
        return [
          {
            telefono: m.telefono,
            ultimo_mensaje: m.texto,
            ultimo_origen: m.origen,
            ultimo_en: m.creado_en,
            modo_humano: actual?.modo_humano ?? false,
          },
          ...resto,
        ];
      });
    };
    socket.on('nuevo_mensaje_chat', onNuevoMensaje);
    // Cuando OTRO operador pausa/reanuda el bot (o resuelve la alerta de
    // "pide asesor", que también libera la conversación), esto lo refleja acá
    // en vivo — antes cada quien solo veía su propia acción hasta hacer F5.
    const onConversacionActualizada = (p: { telefono: string; modo_humano: boolean }) => {
      queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
        prev.map((c) => (c.telefono === p.telefono ? { ...c, modo_humano: p.modo_humano } : c)));
    };
    socket.on('conversacion_actualizada', onConversacionActualizada);
    return () => {
      socket.off('connect', resincronizar);
      socket.off('nuevo_mensaje_chat', onNuevoMensaje);
      socket.off('conversacion_actualizada', onConversacionActualizada);
    };
  }, [queryClient]);

  /** Pausa (activo=true) o reanuda (activo=false) el bot para un número, desde la vista general. */
  async function setModoHumano(telefono: string, activo: boolean) {
    await api.patch(`/api/chat/${encodeURIComponent(telefono)}/modo-humano`, { activo });
    queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
      prev.map((c) => (c.telefono === telefono ? { ...c, modo_humano: activo } : c)));
  }

  return { conversaciones, setModoHumano };
}
