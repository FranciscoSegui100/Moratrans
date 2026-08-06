import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { query } from '../../config/db';
import { env } from '../../config/env';

export const syncRouter = Router();

/**
 * Autenticación por API key (header x-sync-key). El servidor interno del
 * cliente inicia la conexión SALIENTE hacia este endpoint (pull), lee los
 * cambios desde un timestamp y actualiza su copia local. La DB central sigue
 * siendo la única fuente de verdad; esto es sólo replicación de lectura.
 */
function requireSyncKey(req: Request, res: Response, next: NextFunction) {
  const recibida = req.header('x-sync-key') ?? '';
  // Comparación en tiempo constante: evita filtrar la clave byte a byte por
  // el tiempo de respuesta (a diferencia de `!==`, que corta apenas difieren).
  let valida = false;
  try {
    valida = crypto.timingSafeEqual(Buffer.from(recibida), Buffer.from(env.SYNC_API_KEY));
  } catch {
    valida = false; // longitudes distintas
  }
  if (!valida) {
    return res.status(401).json({ error: 'Clave de sincronización inválida' });
  }
  next();
}
syncRouter.use(requireSyncKey);

/**
 * GET /api/sync/pull?since=ISO_TIMESTAMP&entidades=contenedores,pagos
 * Devuelve, por entidad, las filas modificadas desde `since`.
 * El cliente persiste `serverTime` y lo reenvía como `since` en la próxima corrida.
 */
syncRouter.get('/pull', async (req: Request, res: Response) => {
  const since = (req.query.since as string) || '1970-01-01T00:00:00Z';
  const entidades = ((req.query.entidades as string) || 'contenedores,pedidos,pagos,tickets,alertas')
    .split(',')
    .map((e) => e.trim());

  const serverTime = new Date().toISOString();
  const payload: Record<string, any[]> = {};

  // Cada entidad expone una columna temporal para el corte incremental.
  const mapa: Record<string, string> = {
    contenedores: 'SELECT * FROM contenedores WHERE actualizado_en > $1 ORDER BY actualizado_en',
    pedidos: 'SELECT * FROM pedidos WHERE creado_en > $1 ORDER BY creado_en',
    pagos: 'SELECT id, cliente_telefono, pedido_id, monto, estado, creado_en, actualizado_en FROM pagos WHERE actualizado_en > $1 ORDER BY actualizado_en',
    tickets: 'SELECT * FROM tickets WHERE creado_en > $1 ORDER BY creado_en',
    alertas: 'SELECT * FROM alertas WHERE creado_en > $1 ORDER BY creado_en',
    historial: 'SELECT * FROM historial_contenedores WHERE creado_en > $1 ORDER BY creado_en',
  };

  for (const ent of entidades) {
    if (mapa[ent]) payload[ent] = await query(mapa[ent], [since]);
  }

  // Nota: `pagos` no expone url_comprobante/media_id por privacidad en la réplica.
  res.json({ serverTime, since, data: payload });
});

/** GET /api/sync/health — para que el cron del cliente compruebe conectividad. */
syncRouter.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
