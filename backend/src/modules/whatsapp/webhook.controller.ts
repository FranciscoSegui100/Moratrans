import { Router, Request, Response } from 'express';
import { env } from '../../config/env';
import { verifySignature } from './graphApi';
import { normalizar, enrutar } from './messageRouter';
import { query } from '../../config/db';
import { logMensaje } from './chatLog.service';

/**
 * Idempotencia: intenta registrar el message_id. Si ya existía (Meta reintentó
 * porque no recibió el 200 a tiempo), devuelve false y NO se reprocesa.
 */
async function registrarMensaje(messageId?: string): Promise<boolean> {
  if (!messageId) return true; // sin id, procesar igual
  const rows = await query(
    'INSERT INTO mensajes_procesados (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id',
    [messageId],
  );
  return rows.length > 0; // true = primera vez
}

export const webhookRouter = Router();

/**
 * GET /webhook — verificación del webhook (handshake con Meta).
 */
webhookRouter.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * POST /webhook — recepción de eventos.
 * Requiere `express.raw()` en la ruta para poder validar la firma.
 * Responde 200 inmediatamente y procesa async (Meta reintenta si no hay 200).
 */
webhookRouter.post('/', async (req: Request, res: Response) => {
  const signature = req.header('x-hub-signature-256');
  const raw = (req as any).rawBody as Buffer | undefined;

  if (raw && env.WA_APP_SECRET && !verifySignature(raw, signature)) {
    return res.sendStatus(401);
  }

  // ACK inmediato
  res.sendStatus(200);

  try {
    // Soporta tanto el body crudo de Meta (Buffer) como JSON directo (Postman/dev)
    let body: any;
    if (raw && raw.length > 0) {
      body = JSON.parse(raw.toString('utf8'));
    } else {
      body = req.body;
    }
    const entries = body.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const messages = change.value?.messages ?? [];
        for (const msg of messages) {
          const esNuevo = await registrarMensaje(msg.id);
          if (!esNuevo) {
            console.log('Mensaje duplicado ignorado:', msg.id);
            continue;
          }
          const normalizado = normalizar(msg);
          const textoLog =
            normalizado.texto ??
            (normalizado.tipo === 'image' ? '📎 Imagen' : normalizado.tipo === 'document' ? '📎 Documento' : '(mensaje)');
          await logMensaje(normalizado.from, 'cliente', textoLog).catch((e) => console.error('Error logueando mensaje:', e));
          await enrutar(normalizado).catch((e) => console.error('Error enrutando:', e));
        }
      }
    }
  } catch (e) {
    console.error('Error procesando webhook:', e);
  }
});
