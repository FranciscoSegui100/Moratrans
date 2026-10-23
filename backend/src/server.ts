import http from 'http';
import { crearApp } from './app';
import { env, isProd } from './config/env';
import { initSocket } from './config/socket';
import { iniciarCronAlertas } from './jobs/alertas.cron';
import { iniciarCronLimpieza } from './jobs/limpieza.cron';
import { iniciarCronInactividadChat } from './jobs/inactividadChat.cron';
import { iniciarCronDespachoRutas } from './jobs/despachoRutas.cron';

// Red de seguridad: nada de lo que pasa fuera del ciclo request/response de
// Express (ej. una promesa suelta sin .catch en el cron) debe poder tirar
// abajo el proceso completo.
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

const app = crearApp();
const server = http.createServer(app);

// Socket.io sobre el mismo servidor HTTP
initSocket(server);

// Tareas en segundo plano — solo en la instancia de producción: todos
// comparten la MISMA base (DATABASE_URL de prod, no hay una de dev separada),
// así que un `npm run dev` local corriendo en paralelo repetía cada cron sin
// ningún lock entre instancias. Esto duplicaba envíos reales de WhatsApp (el
// aviso/cierre por inactividad, por ejemplo, apareciendo 2+ veces seguidas
// con segundos de diferencia) y podía duplicar efectos de negocio (crear el
// mismo retiro automático dos veces, etc.) — bug encontrado por mensajes
// repetidos en Conversaciones que no coincidían con lo que de verdad mandaba
// el bot una sola vez.
if (isProd) {
  iniciarCronAlertas();
  iniciarCronLimpieza();
  iniciarCronInactividadChat();
  iniciarCronDespachoRutas();
} else {
  console.log('⏰ Crons desactivados (NODE_ENV no es production) — correlos a mano si necesitás probar uno.');
}

// Sin este handler, un puerto ocupado (otra instancia de "npm run dev" que
// quedó corriendo) no tira el proceso: el 'error' de listen() queda sin
// listener, Node lo convierte en una excepción no capturada, y el
// `process.on('uncaughtException', ...)` de arriba — pensado para promesas
// sueltas de los crons — se lo traga. El proceso sigue vivo, sin puerto,
// invisible, pero con los 4 crons de abajo corriendo igual contra la MISMA
// base de producción que la instancia real: cada reinicio de "npm run dev"
// sin matar el anterior sumaba un "zombie" más mandando WhatsApp y
// logueando mensajes duplicados. Acá se detectaron decenas acumulados.
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`No se pudo levantar el servidor en el puerto ${env.PORT}:`, err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`El puerto ${env.PORT} ya está en uso — matá la instancia anterior (lsof -ti:${env.PORT} | xargs kill) antes de levantar una nueva.`);
  }
  process.exit(1);
});

server.listen(env.PORT, () => {
  console.log(`🚀 Backend en http://localhost:${env.PORT}`);
  console.log(`   Webhook WA: /webhook  |  API panel: /api/*`);
});
