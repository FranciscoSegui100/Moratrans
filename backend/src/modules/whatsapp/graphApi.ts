import axios from 'axios';
import crypto from 'crypto';
import FormData from 'form-data';
import { env, isProd } from '../../config/env';
import { normalizarDestinoWhatsApp } from '../../services/telefono.service';
import { logMensaje } from './chatLog.service';

const BASE = `https://graph.facebook.com/${env.WA_GRAPH_VERSION}`;
const PHONE = env.WA_PHONE_NUMBER_ID;

const http = axios.create({
  baseURL: BASE,
  headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
});

/**
 * Extrae solo el mensaje de error útil de un fallo contra la Graph API.
 * Usar SIEMPRE esto (nunca `console.error('...', e)` con el error crudo) al
 * loguear un error de sendText/sendList/sendButtons/sendDocument/uploadMedia:
 * el objeto de error de axios trae el request completo adentro, incluido el
 * header `Authorization: Bearer <token>` en texto plano — lo logueás en
 * texto plano si no filtrás antes.
 */
export function motivoErrorWa(e: any): string {
  return e?.response?.data?.error?.message ?? e?.message ?? String(e);
}

/** Valida la firma X-Hub-Signature-256 del webhook (seguridad contra spoofing). */
export function verifySignature(rawBody: Buffer, signature?: string): boolean {
  if (!env.WA_APP_SECRET) return !isProd; // permitido sólo en dev sin secret; en prod falla cerrado
  if (!signature) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', env.WA_APP_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Envío de texto simple.
 * `log` queda en true por defecto para que quede en el historial de
 * `mensajes_chat` (pantalla "Conversaciones"); se pasa en false cuando quien
 * llama ya lo va a loguear con otro origen (ver POST /api/chat/:telefono,
 * que loguea como 'operador' en vez de 'bot').
 */
export async function sendText(to: string, body: string, opts: { log?: boolean } = {}): Promise<void> {
  const { log = true } = opts;
  const destino = normalizarDestinoWhatsApp(to);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 📲 Texto a ${destino}: "${body}"`);
  } else {
    await http.post(`/${PHONE}/messages`, {
      messaging_product: 'whatsapp',
      to: destino,
      type: 'text',
      text: { body },
    });
  }
  // Loguea con el `to` original (formato wa_id), no con `destino` (formato de
  // envío): así el hilo del cliente y el del bot quedan bajo el MISMO
  // teléfono en mensajes_chat, en vez de partirse en dos conversaciones.
  if (log) await logMensaje(to, 'bot', body).catch((e) => console.error('Error logueando mensaje del bot:', e));
}

/** List message (menú cerrado). rows: [{id, title, description?}] */
export async function sendList(
  to: string,
  header: string,
  body: string,
  buttonText: string,
  rows: { id: string; title: string; description?: string }[],
): Promise<void> {
  const destino = normalizarDestinoWhatsApp(to);

  // Meta Graph API: IDs únicos, máx 10 filas, límites de caracteres
  const seenIds = new Set<string>();
  const sanitizedRows: { id: string; title: string; description?: string }[] = [];
  for (const r of rows) {
    if (!r || !r.id || seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    sanitizedRows.push({
      id: String(r.id).slice(0, 200),
      title: String(r.title || r.id).slice(0, 24),
      ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
    });
    if (sanitizedRows.length >= 10) break;
  }

  if (sanitizedRows.length === 0) {
    console.warn(`[WA sendList] No hay filas válidas para enviar a ${destino}`);
    return;
  }

  const safeHeader = (header || '').slice(0, 60);
  const safeButtonText = (buttonText || 'Ver opciones').slice(0, 20);
  const safeBody = (body || '').slice(0, 1024);

  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 📋 Lista a ${destino}: "${safeHeader}" -> Botón: [${safeButtonText}] con ${sanitizedRows.length} opciones.`);
  } else {
    await http.post(`/${PHONE}/messages`, {
      messaging_product: 'whatsapp',
      to: destino,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: safeHeader },
        body: { text: safeBody },
        action: {
          button: safeButtonText,
          sections: [{ title: 'Opciones', rows: sanitizedRows }],
        },
      },
    });
  }
  await logMensaje(to, 'bot', `${safeBody}\n(opciones: ${sanitizedRows.map((r) => r.title).join(', ')})`)
    .catch((e) => console.error('Error logueando mensaje del bot:', e));
}

/** Botones (máx 3). */
export async function sendButtons(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
): Promise<void> {
  const destino = normalizarDestinoWhatsApp(to);
  const seenIds = new Set<string>();
  const sanitizedButtons: { id: string; title: string }[] = [];
  for (const b of buttons) {
    if (!b || !b.id || seenIds.has(b.id)) continue;
    seenIds.add(b.id);
    sanitizedButtons.push({
      id: String(b.id).slice(0, 256),
      title: String(b.title || b.id).slice(0, 20),
    });
    if (sanitizedButtons.length >= 3) break;
  }
  if (sanitizedButtons.length === 0) return;

  const safeBody = (body || '').slice(0, 1024);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 🔘 Botones a ${destino}: "${safeBody}" -> Opciones:`, sanitizedButtons.map((b) => b.title).join(' | '));
  } else {
    await http.post(`/${PHONE}/messages`, {
      messaging_product: 'whatsapp',
      to: destino,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: safeBody },
        action: {
          buttons: sanitizedButtons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    });
  }
  await logMensaje(to, 'bot', `${safeBody}\n(opciones: ${sanitizedButtons.map((b) => b.title).join(', ')})`)
    .catch((e) => console.error('Error logueando mensaje del bot:', e));
}

/**
 * Pide la ubicación GPS actual del cliente: manda un botón "Enviar ubicación"
 * que abre el selector de mapa nativo del celular. El cliente también puede
 * ignorar el botón y responder con texto (dirección escrita) en su lugar.
 */
export async function sendLocationRequest(to: string, body: string): Promise<void> {
  const destino = normalizarDestinoWhatsApp(to);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 📍 Pedido de ubicación a ${destino}: "${body}"`);
  } else {
    await http.post(`/${PHONE}/messages`, {
      messaging_product: 'whatsapp',
      to: destino,
      type: 'interactive',
      interactive: {
        type: 'location_request_message',
        body: { text: body },
        action: { name: 'send_location' },
      },
    });
  }
  await logMensaje(to, 'bot', body).catch((e) => console.error('Error logueando mensaje del bot:', e));
}

/**
 * Envía un mensaje de PLANTILLA (template) pre-aprobada por Meta.
 * Requerido para mensajes proactivos FUERA de la ventana de 24 h (sección 9).
 * `variables` rellena los {{1}}, {{2}}... del cuerpo, en orden.
 */
export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  variables: string[] = [],
): Promise<void> {
  const destino = normalizarDestinoWhatsApp(to);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] ✉️ Plantilla '${templateName}' a ${destino}. Variables: [${variables.join(', ')}]`);
  } else {
    const components =
      variables.length > 0
        ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: v })) }]
        : [];
    await http.post(`/${PHONE}/messages`, {
      messaging_product: 'whatsapp',
      to: destino,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    });
  }
  await logMensaje(to, 'bot', `[Plantilla: ${templateName}]${variables.length ? ' ' + variables.join(', ') : ''}`)
    .catch((e) => console.error('Error logueando mensaje del bot:', e));
}

/** Descarga un media (comprobante) por su id: 2 pasos (metadata -> binario). */
export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mime: string }> {
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 📥 Simulando descarga de mediaId: ${mediaId}`);
    return { buffer: Buffer.from('mock-file-content'), mime: 'image/jpeg' };
  }
  const meta = await http.get(`/${mediaId}`);
  const url = meta.data.url as string;
  const mime = meta.data.mime_type as string;
  const bin = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
  });
  return { buffer: Buffer.from(bin.data), mime };
}

/** Sube un archivo (en memoria) al endpoint /media y devuelve el media_id. */
export async function uploadMedia(buffer: Buffer, mime: string, filename: string): Promise<string> {
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 📤 Simulando subida de media: ${filename} (${mime})`);
    return 'mock-media-id';
  }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, { filename, contentType: mime });
  const res = await http.post(`/${PHONE}/media`, form, { headers: form.getHeaders() });
  return res.data.id as string;
}

/** Envía un documento (PDF) ya subido, por media_id. */
export async function sendDocument(
  to: string,
  mediaId: string,
  filename: string,
  caption?: string,
): Promise<void> {
  const destino = normalizarDestinoWhatsApp(to);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 📄 Documento a ${destino}: ${filename}${caption ? ' — ' + caption : ''}`);
  } else {
    await http.post(`/${PHONE}/messages`, {
      messaging_product: 'whatsapp',
      to: destino,
      type: 'document',
      document: { id: mediaId, filename, caption },
    });
  }
  await logMensaje(to, 'bot', `[Documento: ${filename}]${caption ? ' — ' + caption : ''}`)
    .catch((e) => console.error('Error logueando mensaje del bot:', e));
}
