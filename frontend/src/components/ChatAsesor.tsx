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

function etiquetaDia(iso: string): string {
  const fecha = new Date(iso);
  const hoy = new Date();
  if (fecha.toDateString() === hoy.toDateString()) return 'Hoy';
  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);
  if (fecha.toDateString() === ayer.toDateString()) return 'Ayer';
  return fecha.toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
}

// sendList/sendButtons (graphApi.ts) loguean el mensaje interactivo como
// "<cuerpo>\n(opciones: A, B, C)" — esto separa ambas partes para poder
// mostrar las opciones como en el mensaje real de WhatsApp, no como texto plano.
const OPCIONES_RE = /\n\(opciones: (.+)\)$/;

function parsearOpciones(texto: string): { cuerpo: string; opciones: string[] | null } {
  const m = texto.match(OPCIONES_RE);
  if (!m) return { cuerpo: texto, opciones: null };
  return { cuerpo: texto.slice(0, m.index), opciones: m[1].split(', ') };
}

/** Agrupa los mensajes por día para intercalar separadores tipo WhatsApp. */
function agruparPorDia(mensajes: MensajeChat[]): { etiqueta: string; mensajes: MensajeChat[] }[] {
  const grupos: { etiqueta: string; mensajes: MensajeChat[] }[] = [];
  for (const m of mensajes) {
    const etiqueta = etiquetaDia(m.creado_en);
    const ultimo = grupos[grupos.length - 1];
    if (ultimo?.etiqueta === etiqueta) ultimo.mensajes.push(m);
    else grupos.push({ etiqueta, mensajes: [m] });
  }
  return grupos;
}

/** Hilo de conversación + cuadro de respuesta libre para la alerta "pide asesor". */
export function ChatAsesor({ telefono, ventanaCerrada }: { telefono: string; ventanaCerrada?: boolean }) {
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
        {agruparPorDia(mensajes).map((grupo) => (
          <div key={grupo.etiqueta + grupo.mensajes[0].id} className="chat-dia-grupo">
            <div className="chat-dia"><span>{grupo.etiqueta}</span></div>
            {grupo.mensajes.map((m) => {
              const { cuerpo, opciones } = parsearOpciones(m.texto);
              return (
                <div key={m.id} className={`chat-burbuja chat-burbuja-${m.origen}`}>
                  <div className="chat-burbuja-autor">{origenLabel[m.origen]}</div>
                  <div className="chat-burbuja-texto">{cuerpo}</div>
                  {opciones && (
                    <div className="chat-opciones">
                      {opciones.map((op) => (
                        <div key={op} className="chat-opcion">{op}</div>
                      ))}
                    </div>
                  )}
                  <div className="chat-burbuja-hora">
                    {new Date(m.creado_en).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        <div ref={finRef} />
      </div>

      {ventanaCerrada && (
        <div className="chat-asesor-aviso">
          Pasaron más de 24hs desde el último mensaje del cliente: WhatsApp ya no permite mandarle texto libre.
          Esperá a que vuelva a escribir para poder responderle.
        </div>
      )}
      <div className="chat-asesor-input">
        <input
          className="form-input"
          placeholder={ventanaCerrada ? 'Ventana de 24hs cerrada' : 'Escribí tu respuesta y se manda por WhatsApp...'}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') enviar(); }}
          disabled={enviando || ventanaCerrada}
        />
        <button className="btn btn-primary btn-sm" onClick={enviar} disabled={enviando || ventanaCerrada || !texto.trim()}>
          <Send strokeWidth={2} /> Enviar
        </button>
      </div>
    </div>
  );
}
