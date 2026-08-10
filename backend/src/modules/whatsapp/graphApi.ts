import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import FormData from 'form-data';
import { env, isProd } from '../../config/env';
import { normalizarDestinoWhatsApp } from '../../services/telefono.service';
import { logMensaje } from './chatLog.service';

export { normalizarDestinoWhatsApp };

const BASE = `https://graph.facebook.com/${env.WA_GRAPH_VERSION}`;
const PHONE = env.WA_PHONE_NUMBER_ID;

const http = axios.create({
  baseURL: BASE,
  headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
});

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
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 📋 Lista a ${destino}: "${header}" -> Botón: [${buttonText}] con ${rows.length} opciones.`);
  } else {
    await http.post(`/${PHONE}/messages`, {
      messaging_product: 'whatsapp',
      to: destino,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: header },
        body: { text: body },
        action: {
          button: buttonText,
          sections: [{ title: 'Opciones', rows }],
        },
      },
    });
  }
  await logMensaje(to, 'bot', `${body}\n(opciones: ${rows.map((r) => r.title).join(', ')})`)
    .catch((e) => console.error('Error logueando mensaje del bot:', e));
}

/** Botones (máx 3). */
export async function sendButtons(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
): Promise<void> {
  const destino = normalizarDestinoWhatsApp(to);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 🔘 Botones a ${destino}: "${body}" -> Opciones:`, buttons.map((b) => b.title).join(' | '));
  } else {
    await http.post(`/${PHONE}/messages`, {
      messaging_product: 'whatsapp',
      to: destino,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    });
  }
  await logMensaje(to, 'bot', `${body}\n(opciones: ${buttons.map((b) => b.title).join(', ')})`)
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

/** Sube un archivo local al endpoint /media y devuelve el media_id. */
export async function uploadMedia(filePath: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', fs.createReadStream(filePath), { contentType: mime });
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
  await http.post(`/${PHONE}/messages`, {
    messaging_product: 'whatsapp',
    to: destino,
    type: 'document',
    document: { id: mediaId, filename, caption },
  });
  await logMensaje(to, 'bot', `[Documento: ${filename}]${caption ? ' — ' + caption : ''}`)
    .catch((e) => console.error('Error logueando mensaje del bot:', e));
}
