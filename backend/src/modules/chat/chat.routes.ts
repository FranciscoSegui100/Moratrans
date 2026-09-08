import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendText } from '../whatsapp/graphApi';
import { logMensaje } from '../whatsapp/chatLog.service';
import { getSesion, setSesion } from '../whatsapp/session.store';
import { resolverAsesor } from '../whatsapp/flows/asesor.flow';
import { emitConversacionActualizada } from '../../config/socket';

export const chatRouter = Router();
chatRouter.use(requireAuth);

/**
 * GET /api/chat — lista TODAS las conversaciones del bot (no solo las que piden asesor), con hilo completo y pausa manual. Suma el nombre del
 * cliente (si ya cotizó alguna vez, tomado del perfil de WhatsApp) y el
 * momento de su último mensaje, para calcular la ventana de 24hs de WhatsApp
 * en el panel (pasado ese lapso sin que el cliente escriba, no se le puede
 * volver a mandar texto libre).
 *
 * Suma también, para la "impronta" de la pestaña Conversaciones:
 *  - `motivo`/`escalado_en`: de la alerta 'solicita_asesor' abierta (si hay
 *    una) — es la base del timer de espera cuando el BOT escaló sola.
 *  - `asignado_a`/`asignado_a_nombre`/`asignado_en`: quién está atendiendo
 *    esta conversación ahora mismo (ver sesiones_chat.contexto.asignadoA),
 *    y desde cuándo — es la base del timer cuando un operador la tomó a mano
 *    sin pasar por una escalación del bot.
 */
chatRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT m.telefono, m.texto AS ultimo_mensaje, m.origen AS ultimo_origen, m.creado_en AS ultimo_en,
            COALESCE((s.contexto->>'modoHumano')::boolean, false) AS modo_humano,
            uc.creado_en AS ultimo_cliente_en,
            p.cliente_nombre AS nombre,
            al.mensaje AS motivo,
            al.creado_en AS escalado_en,
            (s.contexto->>'asignadoA')::uuid AS asignado_a,
            asig.nombre AS asignado_a_nombre,
            (s.contexto->>'asignadoEn')::timestamptz AS asignado_en
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
       LEFT JOIN LATERAL (
         SELECT a.mensaje, a.creado_en FROM alertas a
          WHERE a.tipo = 'solicita_asesor' AND a.referencia_id = m.telefono AND a.estado <> 'resuelta'
          ORDER BY a.creado_en DESC LIMIT 1
       ) al ON true
       LEFT JOIN usuarios asig ON asig.id = (s.contexto->>'asignadoA')::uuid
      ORDER BY m.creado_en DESC
      LIMIT 200`,
  );
  res.json(rows);
});

/**
 * GET /api/chat/:telefono — hilo de conversación con un cliente (para la
 * alerta "pide asesor"). Trae los últimos 200 (ORDER BY ... DESC LIMIT 200)
 * y recién ahí se reordena ascendente para mostrarlo cronológico — pedirlo
 * directo en ASC con LIMIT 200 traía los 200 mensajes MÁS VIEJOS de toda la
 * conversación, no los últimos: en un hilo largo, los mensajes recientes
 * nunca llegaban a mostrarse (bug detectado en conversaciones de prueba con
 * más de 200 mensajes).
 */
chatRouter.get('/:telefono', async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, origen, texto, creado_en FROM (
       SELECT id, origen, texto, creado_en FROM mensajes_chat
        WHERE telefono = $1 ORDER BY creado_en DESC LIMIT 200
     ) ultimos ORDER BY creado_en ASC`,
    [req.params.telefono],
  );
  res.json(rows);
});

/**
 * Toma una conversación para un usuario: la marca "modo humano" y "asignada
 * a él" en un solo paso — pausar y reclamar son la misma acción (ver
 * decisión de producto). Si ya está asignada a OTRO usuario, no la pisa:
 * tira un error 409 con el nombre de quien la tiene, para que dos
 * operadores no terminen respondiendo lo mismo.
 */
async function reclamarConversacion(
  telefono: string,
  usuarioId: string,
): Promise<{ ok: true; asignadoA: string; asignadoANombre: string } | { ok: false; ocupadaPor: string }> {
  const sesion = await getSesion(telefono);
  const asignadoActual = sesion.contexto?.asignadoA as string | undefined;
  if (asignadoActual && asignadoActual !== usuarioId) {
    const [otro] = await query<{ nombre: string }>('SELECT nombre FROM usuarios WHERE id = $1', [asignadoActual]);
    return { ok: false, ocupadaPor: otro?.nombre ?? 'otro operador' };
  }
  const [yo] = await query<{ nombre: string }>('SELECT nombre FROM usuarios WHERE id = $1', [usuarioId]);
  await setSesion({
    ...sesion,
    contexto: { ...sesion.contexto, modoHumano: true, asignadoA: usuarioId, asignadoEn: new Date().toISOString() },
  });
  emitConversacionActualizada({
    telefono,
    modo_humano: true,
    asignado_a: usuarioId,
    asignado_a_nombre: yo?.nombre ?? null,
  });
  return { ok: true, asignadoA: usuarioId, asignadoANombre: yo?.nombre ?? 'vos' };
}

const enviarSchema = z.object({ texto: z.string().min(1).max(4000) });

/**
 * POST /api/chat/:telefono — el operador responde libremente por WhatsApp.
 * Marca la conversación en "modo humano" y la reclama para quien escribe
 * (ver reclamarConversacion) — si ya la tenía tomada otro operador, no deja
 * mandar el mensaje encima (409) para no pisarle la respuesta.
 */
chatRouter.post('/:telefono', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = enviarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Mensaje vacío o demasiado largo' });
  const telefono = req.params.telefono;

  const reclamo = await reclamarConversacion(telefono, req.user!.id);
  if (!reclamo.ok) {
    return res.status(409).json({ error: `Ya la está atendiendo ${reclamo.ocupadaPor}.` });
  }

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

  res.json({ ok: true });
});

const modoHumanoSchema = z.object({ activo: z.boolean() });

/**
 * PATCH /api/chat/:telefono/modo-humano — pausa (y reclama) o reanuda el bot
 * para este número puntual, sin depender de que haya una alerta de "pide
 * asesor" de por medio. Sirve para que un operador tome cualquier
 * conversación desde la vista general y la devuelva al bot cuando termine.
 *
 * `activo:false` ya no solo apaga el flag: llama a resolverAsesor, que
 * además resuelve la alerta 'solicita_asesor' si había una abierta — antes
 * este endpoint dejaba la alerta viva para siempre, y el próximo pedido de
 * asesor del mismo cliente no generaba una alerta nueva (ON CONFLICT DO
 * NOTHING sobre la vieja, todavía abierta).
 */
chatRouter.patch('/:telefono/modo-humano', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = modoHumanoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const telefono = req.params.telefono;

  if (parsed.data.activo) {
    const reclamo = await reclamarConversacion(telefono, req.user!.id);
    if (!reclamo.ok) return res.status(409).json({ error: `Ya la está atendiendo ${reclamo.ocupadaPor}.` });
    return res.json({ ok: true, modoHumano: true, asignadoA: reclamo.asignadoA, asignadoANombre: reclamo.asignadoANombre });
  }

  await resolverAsesor(telefono);
  res.json({ ok: true, modoHumano: false });
});

/**
 * POST /api/chat/:telefono/reclamar — para el caso en que el BOT ya escaló
 * sola (pidió asesor tras N intentos, ver asesor.flow.ts) y la conversación
 * ya está en modo humano, pero todavía nadie la tomó: reclamarla acá no
 * toca `modoHumano` (ya está en true), solo asigna. Mismo bloqueo duro que
 * el resto: si otro operador ya la reclamó, 409.
 */
chatRouter.post('/:telefono/reclamar', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const telefono = req.params.telefono;
  const reclamo = await reclamarConversacion(telefono, req.user!.id);
  if (!reclamo.ok) return res.status(409).json({ error: `Ya la está atendiendo ${reclamo.ocupadaPor}.` });
  res.json({ ok: true, asignadoA: reclamo.asignadoA, asignadoANombre: reclamo.asignadoANombre });
});
