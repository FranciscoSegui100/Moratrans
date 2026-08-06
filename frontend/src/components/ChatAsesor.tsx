import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';
import { useToast } from './Toast';

interface MensajeChat {
  id: string;
  telefono?: string;
  origen: 'cliente' | 'bot' | 'operador';
  texto: string;
  creado_en: string;
}

const origenLabel: Record<MensajeChat['origen'], string> = {
  cliente: 'Cliente',
  bot: 'Bot',
  operador: 'Vos',
};

/** Hilo de conversación + cuadro de respuesta libre para la alerta "pide asesor". */
export function ChatAsesor({ telefono }: { telefono: string }) {
  const [mensajes, setMensajes] = useState<MensajeChat[]>([]);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const { show } = useToast();
  const finRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let activo = true;
    const cargar = () => {
      api
        .get<MensajeChat[]>(`/api/chat/${encodeURIComponent(telefono)}`)
        .then((r) => { if (activo) setMensajes(r.data); })
        .catch(() => {});
    };
    cargar();
    // Push en vivo: apenas llega un mensaje del cliente (o de otro operador)
    // se agrega solo, sin esperar el polling.
    const socket = conectarSocket();
    const onNuevoMensaje = (m: MensajeChat) => {
      if (m.telefono !== telefono) return;
      setMensajes((prev) => (prev.find((x) => x.id === m.id) ? prev : [...prev, m]));
    };
    socket.on('nuevo_mensaje_chat', onNuevoMensaje);
    socket.on('connect', cargar); // resincroniza si hubo un corte de conexión
    // El polling queda como red de seguridad por si se pierde algún evento.
    const interval = setInterval(cargar, 5000);
    return () => {
      activo = false;
      clearInterval(interval);
      socket.off('nuevo_mensaje_chat', onNuevoMensaje);
      socket.off('connect', cargar);
    };
  }, [telefono]);

  useEffect(() => {
    finRef.current?.scrollIntoView({ block: 'nearest' });
  }, [mensajes.length]);

  async function enviar() {
    const valor = texto.trim();
    if (!valor || enviando) return;
    setEnviando(true);
    try {
      await api.post(`/api/chat/${encodeURIComponent(telefono)}`, { texto: valor });
      setTexto('');
      const { data } = await api.get<MensajeChat[]>(`/api/chat/${encodeURIComponent(telefono)}`);
      setMensajes(data);
    } catch (e: any) {
      // el texto queda en el cuadro para reintentar
      show('error', 'No se pudo enviar', e.response?.data?.error || 'Error desconocido al mandar el mensaje');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="chat-asesor">
      <div className="chat-asesor-hilo">
        {mensajes.length === 0 && <div className="text-muted">Todavía no hay mensajes.</div>}
        {mensajes.map((m) => (
          <div key={m.id} className={`chat-burbuja chat-burbuja-${m.origen}`}>
            <div className="chat-burbuja-autor">{origenLabel[m.origen]}</div>
            <div className="chat-burbuja-texto">{m.texto}</div>
            <div className="chat-burbuja-hora">
              {new Date(m.creado_en).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        ))}
        <div ref={finRef} />
      </div>
      <div className="chat-asesor-input">
        <input
          className="form-input"
          placeholder="Escribí tu respuesta y se manda por WhatsApp..."
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') enviar(); }}
          disabled={enviando}
        />
        <button className="btn btn-primary btn-sm" onClick={enviar} disabled={enviando || !texto.trim()}>
          <Send strokeWidth={2} /> Enviar
        </button>
      </div>
    </div>
  );
}
