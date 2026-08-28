// Debe importarse antes que cualquier router: parchea Express para que los
// handlers async que rechazan una promesa (throw dentro de un async function)
// lleguen al error handler en vez de tirar abajo todo el proceso Node.
import 'express-async-errors';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import { env, isProd } from './config/env';
import { requireCsrf } from './middleware/csrf';
import { broadcastCambios } from './middleware/broadcastCambios';
import { webhookRouter } from './modules/whatsapp/webhook.controller';
import { authRouter } from './modules/auth/auth.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { pagosRouter } from './modules/pagos/pagos.routes';
import { alertasRouter } from './modules/alertas/alertas.routes';
import { syncRouter } from './modules/sync/sync.routes';
import { choferesRouter } from './modules/contenedores/choferes.routes';
import { clientesRouter } from './modules/clientes/clientes.routes';
import { contenedoresRouter } from './modules/contenedores/contenedores.routes';
import { ticketsRouter } from './modules/tickets/tickets.routes';
import { viajesRouter } from './modules/viajes/viajes.routes';
import { rutasRouter } from './modules/rutas/rutas.routes';
import { reportesRouter } from './modules/reportes/reportes.routes';
import { finanzasRouter } from './modules/finanzas/finanzas.routes';
import { pedidosRouter } from './modules/pedidos/pedidos.routes';
import { tarifasRouter } from './modules/tarifas/tarifas.routes';
import { ubicacionesRouter } from './modules/ubicaciones/ubicaciones.routes';
import { usuariosRouter } from './modules/usuarios/usuarios.routes';
import { auditoriaRouter } from './modules/auditoria/auditoria.routes';
import { chatRouter } from './modules/chat/chat.routes';
import { configRouter } from './modules/config/config.routes';
import { pool } from './config/db';

export function crearApp() {
  const app = express();

  // Railway/Vercel están detrás de un proxy: sin esto, req.ip y req.secure
  // reflejan al proxy en vez del cliente real (rompe rate-limit por IP y la
  // cookie Secure en producción).
  app.set('trust proxy', 1);

  app.use(helmet({
    // Default de helmet es img-src 'self' data:, pero ComprobanteViewer.tsx
    // descarga el comprobante protegido con fetch y lo muestra con
    // URL.createObjectURL (blob:) — sin agregar blob: acá el browser lo
    // bloquea aunque la imagen ya esté en memoria del lado del cliente.
    contentSecurityPolicy: {
      useDefaults: true,
      directives: { imgSrc: ["'self'", 'data:', 'blob:'] },
    },
  }));

  // origin como función: permite una lista (CORS_ORIGIN admite varios,
  // separados por coma) y es obligatorio para que las cookies con
  // credentials:true funcionen (con wildcard "*" el browser las descarta).
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || env.CORS_ORIGIN.includes(origin)) return cb(null, true);
      cb(new Error('Origen no permitido por CORS'));
    },
    credentials: true,
  }));
  app.use(cookieParser());

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

  // Chequea la DB (no solo que el proceso Express esté vivo): si el pool
  // queda colgado con una conexión muerta (ver comentario en db.ts), el
  // proceso sigue "arriba" pero el bot no puede contestar nada — sin este
  // chequeo, un healthcheck de Railway nunca detectaría ese estado y el
  // servicio se quedaría "Active" para siempre sin reiniciarse solo.
  app.get('/health', async (_req, res) => {
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('DB healthcheck timeout')), 5_000)),
      ]);
      res.json({ ok: true });
    } catch (err) {
      console.error('Healthcheck: la DB no respondió:', err);
      res.status(503).json({ ok: false });
    }
  });

  // authRouter maneja su propia protección CSRF ruta por ruta (login/mfa no
  // la necesitan porque todavía no hay sesión de cookies que un atacante
  // pueda aprovechar; refresh/logout sí la exigen, ver auth.routes.ts).
  app.use('/api/auth', authRouter);

  // Todo lo demás bajo /api ya requiere sesión y exige CSRF en cualquier
  // método mutante (POST/PATCH/PUT/DELETE), porque se autentica con la
  // cookie httpOnly mt_at enviada automáticamente por el browser.
  app.use('/api', requireCsrf);
  // Después de CSRF (así solo corre para requests ya validadas): avisa por
  // socket a todos los operadores conectados cuando algo cambia, para que el
  // panel se actualice solo en cualquier pestaña abierta (ver useLayout /
  // Layout.tsx del lado del frontend).
  app.use('/api', broadcastCambios);

  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/config', configRouter);
  app.use('/api/pagos', pagosRouter);
  app.use('/api/alertas', alertasRouter);
  app.use('/api/choferes', choferesRouter);
  app.use('/api/clientes', clientesRouter);
  app.use('/api/contenedores', contenedoresRouter);
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/viajes', viajesRouter);
  app.use('/api/rutas', rutasRouter);
  app.use('/api/pedidos', pedidosRouter);
  app.use('/api/tarifas', tarifasRouter);
  app.use('/api/ubicaciones', ubicacionesRouter);
  app.use('/api/usuarios', usuariosRouter);
  app.use('/api/auditoria', auditoriaRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/reportes', reportesRouter);
  app.use('/api/finanzas', finanzasRouter);
  app.use('/api/sync', syncRouter);

  // Sirve el build del panel (frontend/dist, copiado acá por `vite build` -> ../backend/public)
  // cuando existe: en Railway un solo servicio sirve API + panel bajo el mismo dominio, evitando
  // el problema de que la cookie mt_csrf (CSRF) no se pueda leer entre dominios distintos. En dev
  // local esta carpeta no existe (el panel corre aparte con `vite dev` en el puerto 5173) y este
  // bloque queda inactivo.
  const frontendDist = path.join(__dirname, '../public');
  if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
    app.use(express.static(frontendDist));
    // Middleware sin patrón de ruta (no 'app.get('*', ...)'): Express 4.21+
    // trae una versión de path-to-regexp que rompe en tiempo de ejecución con
    // comodines de string tipo '*' ("Missing parameter name"). Un middleware
    // plano no pasa por ese parser y matchea cualquier método/path igual.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/webhook') || req.path === '/health') return next();
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

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
