import { rateLimit } from 'express-rate-limit';

/**
 * Store en memoria (default de la librería): alcanza mientras el backend
 * corra en una sola instancia, que es el caso hoy en Railway. Si en algún
 * momento se escala a más de una instancia hace falta un store compartido
 * (Redis) para que el límite sea el mismo en todas — swap de una línea acá,
 * sin tocar los endpoints.
 *
 * Esto es una segunda capa además del bloqueo por cuenta (failed_attempts en
 * `usuarios`, ver auth.routes.ts): protege contra un atacante que reparte los
 * intentos entre muchos emails desde la misma IP, algo que el bloqueo por
 * cuenta no frena.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Esperá unos minutos.' },
});

export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Esperá unos minutos.' },
});

// Más estricto: pedir un reset dispara un email, y no queremos que alguien
// use el endpoint para bombardear la casilla de otra persona.
export const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Esperá unos minutos.' },
});

// Un código TOTP tiene 10^6 combinaciones y una ventana de validez chica,
// pero igual conviene un límite explícito por IP (además del bloqueo por
// cuenta en auth.routes.ts).
export const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Esperá unos minutos.' },
});
