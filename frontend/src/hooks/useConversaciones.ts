import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';

export interface Conversacion {
  telefono: string;
  nombre: string | null;
  ultimo_mensaje: string;
  ultimo_origen: 'cliente' | 'bot' | 'operador';
  ultimo_en: string;
  ultimo_cliente_en: string | null;
  modo_humano: boolean;
  /** Motivo del pedido de asesor (alertas.mensaje), si el bot escaló sola. */
  motivo: string | null;
  /** Cuándo se creó esa alerta — base del timer de espera cuando escaló el bot. */
  escalado_en: string | null;
  /** Quién la está atendiendo ahora mismo (o null si nadie la reclamó todavía). */
  asignado_a: string | null;
  asignado_a_nombre: string | null;
  /** Desde cuándo la tiene asignada — base del timer cuando la tomó un operador sin escalación del bot. */
  asignado_en: string | null;
}

interface MensajeChatSocket {
  telefono: string;
  texto: string;
  origen: Conversacion['ultimo_origen'];
  creado_en: string;
}

interface ConversacionActualizadaSocket {
  telefono: string;
  modo_humano: boolean;
  asignado_a?: string | null;
  asignado_a_nombre?: string | null;
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
            nombre: actual?.nombre ?? null,
            ultimo_mensaje: m.texto,
            ultimo_origen: m.origen,
            ultimo_en: m.creado_en,
            // Solo un mensaje DEL CLIENTE reabre la ventana de 24hs de WhatsApp.
            ultimo_cliente_en: m.origen === 'cliente' ? m.creado_en : actual?.ultimo_cliente_en ?? null,
            modo_humano: actual?.modo_humano ?? false,
            motivo: actual?.motivo ?? null,
            escalado_en: actual?.escalado_en ?? null,
            asignado_a: actual?.asignado_a ?? null,
            asignado_a_nombre: actual?.asignado_a_nombre ?? null,
            asignado_en: actual?.asignado_en ?? null,
          },
          ...resto,
        ];
      });
    };
    socket.on('nuevo_mensaje_chat', onNuevoMensaje);
    // Cuando OTRO operador pausa/reanuda el bot, reclama una conversación, o
    // se resuelve la alerta de "pide asesor" (que también libera todo), esto
    // lo refleja acá en vivo — antes cada quien solo veía su propia acción
    // hasta hacer F5.
    const onConversacionActualizada = (p: ConversacionActualizadaSocket) => {
      queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
        prev.map((c) =>
          c.telefono === p.telefono
            ? {
                ...c,
                modo_humano: p.modo_humano,
                asignado_a: p.asignado_a !== undefined ? p.asignado_a : c.asignado_a,
                asignado_a_nombre: p.asignado_a_nombre !== undefined ? p.asignado_a_nombre : c.asignado_a_nombre,
                asignado_en: p.modo_humano ? c.asignado_en ?? new Date().toISOString() : null,
                motivo: p.modo_humano ? c.motivo : null,
                escalado_en: p.modo_humano ? c.escalado_en : null,
              }
            : c,
        ));
    };
    socket.on('conversacion_actualizada', onConversacionActualizada);
    return () => {
      socket.off('connect', resincronizar);
      socket.off('nuevo_mensaje_chat', onNuevoMensaje);
      socket.off('conversacion_actualizada', onConversacionActualizada);
    };
  }, [queryClient]);

  /** Pausa+reclama (activo=true) o resuelve/reanuda (activo=false) el bot para un número, desde la vista general. Tira si otro operador ya la tenía tomada (409). */
  async function setModoHumano(telefono: string, activo: boolean) {
    const { data } = await api.patch<{ ok: true; modoHumano: boolean; asignadoA?: string; asignadoANombre?: string }>(
      `/api/chat/${encodeURIComponent(telefono)}/modo-humano`,
      { activo },
    );
    queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
      prev.map((c) =>
        c.telefono === telefono
          ? {
              ...c,
              modo_humano: data.modoHumano,
              asignado_a: activo ? data.asignadoA ?? c.asignado_a : null,
              asignado_a_nombre: activo ? data.asignadoANombre ?? c.asignado_a_nombre : null,
              asignado_en: activo ? new Date().toISOString() : null,
              motivo: activo ? c.motivo : null,
              escalado_en: activo ? c.escalado_en : null,
            }
          : c,
      ));
  }

  /** Reclama una conversación que el BOT ya puso en modo humano sola (pidió asesor) pero que todavía nadie tomó. Tira si otro operador se adelantó (409). */
  async function reclamar(telefono: string) {
    const { data } = await api.post<{ ok: true; asignadoA: string; asignadoANombre: string }>(
      `/api/chat/${encodeURIComponent(telefono)}/reclamar`,
    );
    queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
      prev.map((c) =>
        c.telefono === telefono ? { ...c, asignado_a: data.asignadoA, asignado_a_nombre: data.asignadoANombre } : c,
      ));
  }

  return { conversaciones, setModoHumano, reclamar };
}
