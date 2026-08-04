// Debe importarse antes que cualquier router: parchea Express para que los
// handlers async que rechazan una promesa (throw dentro de un async function)
// lleguen al error handler en vez de tirar abajo todo el proceso Node.
import 'express-async-errors';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { env, isProd } from './config/env';
import { webhookRouter } from './modules/whatsapp/webhook.controller';
import { authRouter } from './modules/auth/auth.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { pagosRouter } from './modules/pagos/pagos.routes';
import { alertasRouter } from './modules/alertas/alertas.routes';
import { syncRouter } from './modules/sync/sync.routes';
import { choferesRouter } from './modules/contenedores/choferes.routes';
import { contenedoresRouter } from './modules/contenedores/contenedores.routes';
import { ticketsRouter } from './modules/tickets/tickets.routes';
import { viajesRouter } from './modules/viajes/viajes.routes';
import { reportesRouter } from './modules/reportes/reportes.routes';
import { pedidosRouter } from './modules/pedidos/pedidos.routes';
import { tarifasRouter } from './modules/tarifas/tarifas.routes';
import { usuariosRouter } from './modules/usuarios/usuarios.routes';

export function crearApp() {
  const app = express();

  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));

  // Webhook de Meta: necesita el cuerpo CRUDO para validar la firma HMAC.
  app.use(
    '/webhook',
    express.raw({ type: '*/*' }),
    (req, _res, next) => {
      (req as any).rawBody = req.body; // Buffer
      next();
    },
    webhookRouter,
  );

  // El resto usa JSON normal.
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/pagos', pagosRouter);
  app.use('/api/alertas', alertasRouter);
  app.use('/api/choferes', choferesRouter);
  app.use('/api/contenedores', contenedoresRouter);
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/viajes', viajesRouter);
  app.use('/api/pedidos', pedidosRouter);
  app.use('/api/tarifas', tarifasRouter);
  app.use('/api/usuarios', usuariosRouter);
  app.use('/api/reportes', reportesRouter);
  app.use('/api/sync', syncRouter);

  // Error handler global: cualquier excepción/rechazo de un handler (sync o
  // async, gracias a express-async-errors) termina acá en vez de tirar abajo
  // el proceso. Sin esto, un solo request con un dato inválido (ej. un UUID
  // mal formado) crashea el backend entero para todos los usuarios.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Error no manejado en request:', err);
    if (res.headersSent) return;
    const status = err?.status ?? err?.statusCode ?? 500;
    res.status(status).json({
      error: isProd ? 'Error interno del servidor' : String(err?.message ?? err),
    });
  });

  return app;
}
