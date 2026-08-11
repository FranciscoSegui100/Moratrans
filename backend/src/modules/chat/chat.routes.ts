import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendText } from '../whatsapp/graphApi';
import { logMensaje } from '../whatsapp/chatLog.service';
import { getSesion, setSesion } from '../whatsapp/session.store';
import { emitConversacionActualizada } from '../../config/socket';

export const chatRouter = Router();
chatRouter.use(requireAuth);

/**
 * GET /api/chat — lista TODAS las conversaciones (no solo las escaladas a
 * "asesor"): último mensaje de cada teléfono + si el bot está pausado
 * (modoHumano) para esa conversación en este momento. Suma el nombre del
 * cliente (si ya cotizó alguna vez, tomado del perfil de WhatsApp) y el
 * momento de su último mensaje, para calcular la ventana de 24hs de WhatsApp
 * en el panel (pasado ese lapso sin que el cliente escriba, no se le puede
 * volver a mandar texto libre).
 */
chatRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT m.telefono, m.texto AS ultimo_mensaje, m.origen AS ultimo_origen, m.creado_en AS ultimo_en,
            COALESCE((s.contexto->>'modoHumano')::boolean, false) AS modo_humano,
            uc.creado_en AS ultimo_cliente_en,
            p.cliente_nombre AS nombre
       FROM (
         SELECT DISTINCT ON (telefono) telefono, texto, origen, creado_en
           FROM mensajes_chat
          ORDER BY telefono, creado_en DESC
       ) m
       LEFT JOIN sesiones_chat s ON s.telefono = m.telefono
       LEFT JOIN LATERAL (
         SELECT mc.creado_en FROM mensajes_chat mc
          WHERE mc.telefono = m.telefono AND mc.origen = 'cliente'
          ORDER BY mc.creado_en DESC LIMIT 1
       ) uc ON true
       LEFT JOIN LATERAL (
         SELECT pd.cliente_nombre FROM pedidos pd
          WHERE pd.cliente_telefono = m.telefono AND pd.cliente_nombre IS NOT NULL
          ORDER BY pd.creado_en DESC LIMIT 1
       ) p ON true
      ORDER BY m.creado_en DESC
      LIMIT 200`,
  );
  res.json(rows);
});

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

  try {
    // log: false — este envío se loguea abajo como 'operador' (con usuarioId),
    // no como 'bot' (que es lo que sendText hace por defecto para cualquier
    // otro llamador en los flujos automáticos).
    await sendText(telefono, parsed.data.texto, { log: false });
  } catch (e: any) {
    const motivoMeta = e.response?.data?.error?.message as string | undefined;
    console.error('Error enviando mensaje de operador por WhatsApp:', motivoMeta ?? e.message);
    // Causa más común en WhatsApp Cloud API: pasaron >24hs desde el último
    // mensaje del cliente y ya no se puede mandar texto libre (solo templates).
    const ventanaVencida = /24\s*hour|window|re-?engagement/i.test(motivoMeta ?? '');
    return res.status(502).json({
      error: ventanaVencida
        ? 'No se pudo enviar: pasaron más de 24hs desde el último mensaje del cliente. WhatsApp exige que el cliente escriba primero para volver a habilitar el chat.'
        : 'No se pudo enviar el mensaje por WhatsApp. Probá de nuevo en un momento.',
    });
  }
  await logMensaje(telefono, 'operador', parsed.data.texto, req.user!.id);

  const sesion = await getSesion(telefono);
  await setSesion({ ...sesion, contexto: { ...sesion.contexto, modoHumano: true } });
  emitConversacionActualizada({ telefono, modo_humano: true });

  res.json({ ok: true });
});

const modoHumanoSchema = z.object({ activo: z.boolean() });

/**
 * PATCH /api/chat/:telefono/modo-humano — pausa o reanuda el bot para este
 * número puntual, sin depender de que haya una alerta de "pide asesor" de
 * por medio (a diferencia de POST /:telefono, que solo pausa al enviar un
 * mensaje). Sirve para que un operador tome cualquier conversación desde la
 * vista general y la devuelva al bot cuando termine.
 */
chatRouter.patch('/:telefono/modo-humano', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = modoHumanoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const telefono = req.params.telefono;

  const sesion = await getSesion(telefono);
  await setSesion({ ...sesion, contexto: { ...sesion.contexto, modoHumano: parsed.data.activo } });
  emitConversacionActualizada({ telefono, modo_humano: parsed.data.activo });

  res.json({ ok: true, modoHumano: parsed.data.activo });
});
