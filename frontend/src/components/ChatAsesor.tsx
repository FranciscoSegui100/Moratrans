import { useEffect, useRef, useState } from 'react';
import { Send, Wallet, Mic, MicOff, Play, Square } from 'lucide-react';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';
import { useToast } from './Toast';
import { ComprobanteViewer } from './ComprobanteViewer';

interface MensajeChat {
  id: string;
  telefono?: string;
  origen: 'cliente' | 'bot' | 'operador';
  texto: string;
  creado_en: string;
  // El cliente mandó una imagen/PDF en este mensaje y quedó guardada.
  tiene_adjunto?: boolean;
  // El mensaje es una nota de voz (cliente o asesor).
  tiene_audio?: boolean;
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

const OPCIONES_RE = /\n\(opciones: (.+)\)$/;

function parsearOpciones(texto: string): { cuerpo: string; opciones: string[] | null } {
  const m = texto.match(OPCIONES_RE);
  if (!m) return { cuerpo: texto, opciones: null };
  return { cuerpo: texto.slice(0, m.index), opciones: m[1].split(', ') };
}

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

/** Reproductor de audio inline para notas de voz — ruta del backend según origen. */
function AudioPlayer({ mensajeId, origen }: { mensajeId: string; origen: MensajeChat['origen'] }) {
  const src = `/api/chat/mensaje/${mensajeId}/audio`;
  return (
    <div className="chat-audio-player">
      <audio controls preload="metadata" style={{ width: '100%', height: '36px' }}>
        <source src={src} />
        Tu navegador no soporta audio.
      </audio>
    </div>
  );
}

/** Botón de grabación con MediaRecorder — graba en memoria y envía al backend. */
function GrabadorAudio({
  telefono,
  disabled,
  onEnviado,
}: {
  telefono: string;
  disabled: boolean;
  onEnviado: () => void;
}) {
  const { show } = useToast();
  const [grabando, setGrabando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Límite de 120 segundos para que no quede grabando solo
  const MAX_SEG = 120;

  async function iniciarGrabacion() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const opciones: MediaRecorderOptions = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? { mimeType: 'audio/ogg;codecs=opus' }
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? { mimeType: 'audio/webm;codecs=opus' }
        : {};
      const recorder = new MediaRecorder(stream, opciones);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = recorder.mimeType || 'audio/ogg';
        const blob = new Blob(chunksRef.current, { type: mime });
        await enviarAudio(blob, mime);
      };
      recorder.start(250);
      mediaRef.current = recorder;
      setGrabando(true);
      setSegundos(0);
      timerRef.current = setInterval(() => {
        setSegundos((s) => {
          if (s + 1 >= MAX_SEG) detenerGrabacion();
          return s + 1;
        });
      }, 1000);
    } catch (e: any) {
      show('error', 'No se pudo acceder al micrófono', e.message ?? 'Verificá los permisos del navegador');
    }
  }

  function detenerGrabacion() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRef.current && mediaRef.current.state !== 'inactive') {
      mediaRef.current.stop();
    }
    setGrabando(false);
    setSegundos(0);
  }

  async function enviarAudio(blob: Blob, mime: string) {
    setEnviando(true);
    try {
      const ext = mime.includes('ogg') ? 'ogg' : mime.includes('webm') ? 'webm' : 'ogg';
      const form = new FormData();
      form.append('audio', blob, `nota_voz.${ext}`);
      await api.post(`/api/chat/${encodeURIComponent(telefono)}/audio`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      onEnviado();
    } catch (e: any) {
      show('error', 'No se pudo enviar el audio', e.response?.data?.error || 'Error desconocido');
    } finally {
      setEnviando(false);
    }
  }

  function formatSeg(s: number) {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${String(ss).padStart(2, '0')}`;
  }

  if (enviando) {
    return (
      <button className="btn btn-ghost btn-sm" disabled title="Enviando audio...">
        <Square size={15} strokeWidth={2} className="chat-audio-pulse" /> Enviando…
      </button>
    );
  }

  if (grabando) {
    return (
      <button
        className="btn btn-danger btn-sm"
        onClick={detenerGrabacion}
        title="Detener y enviar la nota de voz"
      >
        <Square size={15} strokeWidth={2} />
        <span className="chat-audio-timer">{formatSeg(segundos)}</span>
        Enviar
      </button>
    );
  }

  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={iniciarGrabacion}
      disabled={disabled}
      title="Grabar y enviar una nota de voz por WhatsApp"
    >
      <Mic size={15} strokeWidth={2} /> Nota de voz
    </button>
  );
}

/** Hilo de conversación + cuadro de respuesta libre para la alerta "pide asesor". */
export function ChatAsesor({ telefono, ventanaCerrada }: { telefono: string; ventanaCerrada?: boolean }) {
  const [mensajes, setMensajes] = useState<MensajeChat[]>([]);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [pidiendoTransferencia, setPidiendoTransferencia] = useState(false);
  const { show } = useToast();
  const finRef = useRef<HTMLDivElement>(null);

  const cargar = async () => {
    try {
      const { data } = await api.get<MensajeChat[]>(`/api/chat/${encodeURIComponent(telefono)}`);
      setMensajes(data);
    } catch {}
  };

  useEffect(() => {
    let activo = true;
    const cargarActivo = () => {
      api
        .get<MensajeChat[]>(`/api/chat/${encodeURIComponent(telefono)}`)
        .then((r) => { if (activo) setMensajes(r.data); })
        .catch(() => {});
    };
    cargarActivo();
    const socket = conectarSocket();
    const onNuevoMensaje = (m: MensajeChat) => {
      if (m.telefono !== telefono) return;
      setMensajes((prev) => (prev.find((x) => x.id === m.id) ? prev : [...prev, m]));
    };
    socket.on('nuevo_mensaje_chat', onNuevoMensaje);
    socket.on('connect', cargarActivo);
    const interval = setInterval(cargarActivo, 5000);
    return () => {
      activo = false;
      clearInterval(interval);
      socket.off('nuevo_mensaje_chat', onNuevoMensaje);
      socket.off('connect', cargarActivo);
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
      show('error', 'No se pudo enviar', e.response?.data?.error || 'Error desconocido al mandar el mensaje');
    } finally {
      setEnviando(false);
    }
  }

  async function pedirTransferencia() {
    const concepto = prompt('¿Qué le cotizaste? (se lo mandamos al cliente como referencia)');
    if (!concepto?.trim()) return;
    const montoTexto = prompt('¿Por cuánto se lo cotizaste? (monto en pesos)');
    const monto = Number(montoTexto);
    if (!montoTexto || !(monto > 0)) {
      show('error', 'Monto inválido', 'Ingresá un número mayor a cero.');
      return;
    }
    setPidiendoTransferencia(true);
    try {
      await api.post('/api/pagos/pedido-catalogo', { telefono, monto, concepto: concepto.trim() });
      show('success', 'Transferencia pedida', 'Le mandamos los datos bancarios al cliente por WhatsApp.');
    } catch (e: any) {
      show('error', 'No se pudo pedir la transferencia', e.response?.data?.error || 'Error desconocido');
    } finally {
      setPidiendoTransferencia(false);
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
                  {/* Nota de voz: mostrar reproductor en vez del texto */}
                  {m.tiene_audio ? (
                    <AudioPlayer mensajeId={m.id} origen={m.origen} />
                  ) : (
                    <div className="chat-burbuja-texto">{cuerpo}</div>
                  )}
                  {m.tiene_adjunto && <ComprobanteViewer mensajeId={m.id} />}
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
      <div className="chat-asesor-acciones">
        <button
          className="btn btn-ghost btn-sm"
          onClick={pedirTransferencia}
          disabled={pidiendoTransferencia || ventanaCerrada}
          title="Después de cotizarle a mano, pedile el comprobante de la transferencia"
        >
          <Wallet strokeWidth={1.75} /> Pedir transferencia
        </button>
        <GrabadorAudio
          telefono={telefono}
          disabled={!!ventanaCerrada}
          onEnviado={cargar}
        />
      </div>
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
