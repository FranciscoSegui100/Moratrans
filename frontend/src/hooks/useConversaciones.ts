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
  /** 'aprobada' = cliente de cuenta corriente; cualquier otro valor (o null, sin fila en clientes) = cliente común. */
  cuenta_corriente_estado: 'sin_pedir' | 'pendiente' | 'aprobada' | 'rechazada' | null;
  /** Si no es null, esta conversación es con un CHOFER (no un cliente) — la lista mezcla ambos. */
  chofer_nombre: string | null;
  /** Mensajes del cliente que el usuario logueado todavía no leyó (cada operador tiene los suyos; tope 99). */
  no_leidos: number;
}

interface MensajeChatSocket {
  telefono: string;
  texto: string;
  origen: Conversacion['ultimo_origen'];
  creado_en: string;
}

interface ConversacionActualizadaSocket {
  telefono: string;
  modo_humano?: boolean;
  nombre?: string | null;
  asignado_a?: string | null;
  asignado_a_nombre?: string | null;
  eliminada?: boolean;
}

const CONVERSACIONES_KEY = ['conversaciones'];

/** Evento de ventana que dispara marcarLeido (lo escucha el badge del sidebar). */
export const EVENTO_CHAT_LEIDO = 'moratrans:chat-leido';

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
            cuenta_corriente_estado: actual?.cuenta_corriente_estado ?? null,
            chofer_nombre: actual?.chofer_nombre ?? null,
            // Solo un mensaje DEL CLIENTE cuenta como no leído (lo que manda
            // el bot o un operador no). Si el chat está abierto, Conversaciones
            // lo vuelve a marcar leído enseguida (ver marcarLeido).
            no_leidos: m.origen === 'cliente' ? (actual?.no_leidos ?? 0) + 1 : actual?.no_leidos ?? 0,
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
      if (p.eliminada) {
        queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
          prev.filter((c) => c.telefono !== p.telefono),
        );
        return;
      }
      queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
        prev.map((c) =>
          c.telefono === p.telefono
            ? {
                ...c,
                nombre: p.nombre !== undefined ? p.nombre : c.nombre,
                modo_humano: p.modo_humano !== undefined ? p.modo_humano : c.modo_humano,
                asignado_a: p.asignado_a !== undefined ? p.asignado_a : c.asignado_a,
                asignado_a_nombre: p.asignado_a_nombre !== undefined ? p.asignado_a_nombre : c.asignado_a_nombre,
                asignado_en: (p.modo_humano !== undefined ? p.modo_humano : c.modo_humano) ? c.asignado_en ?? new Date().toISOString() : null,
                motivo: (p.modo_humano !== undefined ? p.modo_humano : c.modo_humano) ? c.motivo : null,
                escalado_en: (p.modo_humano !== undefined ? p.modo_humano : c.modo_humano) ? c.escalado_en : null,
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

  /**
   * Pausa+reclama (activo=true) o resuelve/reanuda (activo=false) el bot
   * para un número, desde la vista general. Tira si otro operador ya la
   * tenía tomada (409) — salvo `forzar:true` (botón "Tomar igual", para
   * destrabar un chat asignado a alguien que ya no está con el panel
   * abierto). `activo:false` siempre funciona sin importar quién la tenía.
   */
  async function setModoHumano(telefono: string, activo: boolean, forzar?: boolean) {
    const { data } = await api.patch<{ ok: true; modoHumano: boolean; asignadoA?: string; asignadoANombre?: string }>(
      `/api/chat/${encodeURIComponent(telefono)}/modo-humano`,
      { activo, forzar },
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

  /**
   * Reclama una conversación que el BOT ya puso en modo humano sola (pidió
   * asesor) pero que todavía nadie tomó. Tira si otro operador se adelantó
   * (409) — salvo `forzar:true` (botón "Tomar igual" en el panel).
   */
  async function reclamar(telefono: string, forzar?: boolean) {
    const { data } = await api.post<{ ok: true; asignadoA: string; asignadoANombre: string }>(
      `/api/chat/${encodeURIComponent(telefono)}/reclamar`,
      { forzar },
    );
    queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
      prev.map((c) =>
        c.telefono === telefono ? { ...c, asignado_a: data.asignadoA, asignado_a_nombre: data.asignadoANombre } : c,
      ));
  }

  /**
   * El usuario abrió (o tiene abierto) este chat: queda leído PARA ÉL en la
   * base. Optimista. Avisa con un evento de ventana para que el badge de
   * "Conversaciones" del sidebar (Layout.tsx) lo descuente sin otro request.
   */
  async function marcarLeido(telefono: string) {
    queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
      prev.map((c) => (c.telefono === telefono ? { ...c, no_leidos: 0 } : c)));
    window.dispatchEvent(new CustomEvent(EVENTO_CHAT_LEIDO, { detail: { telefono } }));
    await api.put(`/api/chat/${encodeURIComponent(telefono)}/leido`).catch(() => {});
  }

  async function eliminarConversacion(telefono: string) {
    await api.delete(`/api/chat/${encodeURIComponent(telefono)}`);
    queryClient.setQueryData<Conversacion[]>(CONVERSACIONES_KEY, (prev = []) =>
      prev.filter((c) => c.telefono !== telefono),
    );
    queryClient.removeQueries({ queryKey: ['chat', telefono] });
    window.dispatchEvent(new CustomEvent(EVENTO_CHAT_LEIDO, { detail: { telefono } }));
  }

  return { conversaciones, setModoHumano, reclamar, marcarLeido, eliminarConversacion };
}
