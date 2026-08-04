import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import FormData from 'form-data';
import { env } from '../../config/env';
import { normalizarDestinoWhatsApp } from '../../services/telefono.service';

export { normalizarDestinoWhatsApp };

const BASE = `https://graph.facebook.com/${env.WA_GRAPH_VERSION}`;
const PHONE = env.WA_PHONE_NUMBER_ID;

const http = axios.create({
  baseURL: BASE,
  headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
});

/** Valida la firma X-Hub-Signature-256 del webhook (seguridad contra spoofing). */
export function verifySignature(rawBody: Buffer, signature?: string): boolean {
  if (!env.WA_APP_SECRET) return true; // permitido sólo en dev sin secret
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

/** Envío de texto simple. */
export async function sendText(to: string, body: string): Promise<void> {
  to = normalizarDestinoWhatsApp(to);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 📲 Texto a ${to}: "${body}"`);
    return;
  }
  await http.post(`/${PHONE}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
}

/** List message (menú cerrado). rows: [{id, title, description?}] */
export async function sendList(
  to: string,
  header: string,
  body: string,
  buttonText: string,
  rows: { id: string; title: string; description?: string }[],
): Promise<void> {
  to = normalizarDestinoWhatsApp(to);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 📋 Lista a ${to}: "${header}" -> Botón: [${buttonText}] con ${rows.length} opciones.`);
    return;
  }
  await http.post(`/${PHONE}/messages`, {
    messaging_product: 'whatsapp',
    to,
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

/** Botones (máx 3). */
export async function sendButtons(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
): Promise<void> {
  to = normalizarDestinoWhatsApp(to);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] 🔘 Botones a ${to}: "${body}" -> Opciones:`, buttons.map((b) => b.title).join(' | '));
    return;
  }
  await http.post(`/${PHONE}/messages`, {
    messaging_product: 'whatsapp',
    to,
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
  to = normalizarDestinoWhatsApp(to);
  if (env.WA_ACCESS_TOKEN === 'mock') {
    console.log(`[MOCK WA] ✉️ Plantilla '${templateName}' a ${to}. Variables: [${variables.join(', ')}]`);
    return;
  }
  const components =
    variables.length > 0
      ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: v })) }]
      : [];
  await http.post(`/${PHONE}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {}),
    },
  });
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
  to = normalizarDestinoWhatsApp(to);
  await http.post(`/${PHONE}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: { id: mediaId, filename, caption },
  });
}
