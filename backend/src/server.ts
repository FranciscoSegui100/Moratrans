import http from 'http';
import { crearApp } from './app';
import { env } from './config/env';
import { initSocket } from './config/socket';
import { iniciarCronAlertas } from './jobs/alertas.cron';

// Red de seguridad: nada de lo que pasa fuera del ciclo request/response de
// Express (ej. una promesa suelta sin .catch en el cron) debe poder tirar
// abajo el proceso completo.
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

const app = crearApp();
const server = http.createServer(app);

// Socket.io sobre el mismo servidor HTTP
initSocket(server);

// Tareas en segundo plano
iniciarCronAlertas();

server.listen(env.PORT, () => {
  console.log(`🚀 Backend en http://localhost:${env.PORT}`);
  console.log(`   Webhook WA: /webhook  |  API panel: /api/*`);
});
