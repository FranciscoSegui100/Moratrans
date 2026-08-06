import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendText } from '../whatsapp/graphApi';
import { logMensaje } from '../whatsapp/chatLog.service';
import { getSesion, setSesion } from '../whatsapp/session.store';

export const chatRouter = Router();
chatRouter.use(requireAuth);

/** GET /api/chat/:telefono — hilo de conversación con un cliente (para la alerta "pide asesor"). */
chatRouter.get('/:telefono', async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, origen, texto, creado_en FROM mensajes_chat
      WHERE telefono = $1 ORDER BY creado_en ASC LIMIT 200`,
    [req.params.telefono],
  );
  res.json(rows);
});

const enviarSchema = z.object({ texto: z.string().min(1).max(4000) });

/**
 * POST /api/chat/:telefono — el operador responde libremente por WhatsApp.
 * Marca la conversación en "modo humano": el bot deja de auto-responder a
 * este número hasta que se resuelva la alerta o el cliente escriba "menú".
 */
chatRouter.post('/:telefono', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = enviarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Mensaje vacío o demasiado largo' });
  const telefono = req.params.telefono;

  await sendText(telefono, parsed.data.texto);
  await logMensaje(telefono, 'operador', parsed.data.texto, req.user!.id);

  const sesion = await getSesion(telefono);
  await setSesion({ ...sesion, contexto: { ...sesion.contexto, modoHumano: true } });

  res.json({ ok: true });
});
