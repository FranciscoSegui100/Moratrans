import { Router, Request, Response } from 'express';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { obtenerEstadoBot, establecerEstadoBot } from '../../services/botConfig.service';

export const configRouter = Router();
configRouter.use(requireAuth);

/** GET /api/config/bot — estado actual del interruptor de atención automática a clientes. */
configRouter.get('/bot', async (_req: Request, res: Response) => {
  res.json(await obtenerEstadoBot());
});

/**
 * PATCH /api/config/bot — prende/apaga la atención automática a clientes.
 * No afecta a los choferes (ver messageRouter.ts::enrutar). broadcastCambios
 * (app.ts) ya avisa por socket a los demás operadores conectados.
 */
configRouter.patch('/bot', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const activo = !!req.body?.bot_activo;
  const estado = await establecerEstadoBot(activo, req.user!.id);
  res.json(estado);
});
