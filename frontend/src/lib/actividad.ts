/**
 * Última actividad REAL de la persona en el panel (mouse, teclado, toques,
 * scroll) — no cuentan las consultas automáticas ni la renovación de sesión
 * de fondo. Sin "Recordarme", la sesión se cierra tras
 * SESION_INACTIVIDAD_HORAS sin actividad (ver backend: config/env.ts y
 * POST /api/auth/refresh, que recibe este dato en X-Inactivo-Ms).
 *
 * Se guarda en localStorage para que sea la misma en todas las pestañas: usar
 * el panel en una pestaña mantiene viva la sesión de las otras.
 */

/** Mismo valor que SESION_INACTIVIDAD_HORAS en el backend (default 12) — mantener en sync. */
export const INACTIVIDAD_MAX_MS = 12 * 60 * 60 * 1000;

const CLAVE = 'mt_ultima_actividad';
const EVENTOS = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel'] as const;

let enMemoria = Date.now();

export function registrarActividad(): void {
  enMemoria = Date.now();
  try {
    localStorage.setItem(CLAVE, String(enMemoria));
  } catch {
    // localStorage bloqueado (modo privado, etc.): queda solo en memoria.
  }
}

function ultimaActividad(): number {
  try {
    const guardada = Number(localStorage.getItem(CLAVE));
    if (Number.isFinite(guardada) && guardada > 0) return Math.max(guardada, enMemoria);
  } catch {
    // idem
  }
  return enMemoria;
}

export function msDesdeUltimaActividad(): number {
  return Math.max(0, Date.now() - ultimaActividad());
}

/** Escucha la actividad del usuario (a lo sumo una escritura por minuto). Devuelve la función para dejar de escuchar. */
export function seguirActividad(): () => void {
  let ultimaEscritura = 0;
  const alActuar = () => {
    const ahora = Date.now();
    if (ahora - ultimaEscritura < 60_000) return;
    ultimaEscritura = ahora;
    registrarActividad();
  };
  for (const e of EVENTOS) window.addEventListener(e, alActuar, { passive: true });
  return () => {
    for (const e of EVENTOS) window.removeEventListener(e, alActuar);
  };
}
