import crypto from 'crypto';
import zxcvbn from 'zxcvbn';

const LARGO_MINIMO = 12;
const SCORE_MINIMO = 3; // zxcvbn: 0 (pésima) a 4 (excelente)

/**
 * Consulta la API pública de HaveIBeenPwned con k-anonymity: solo se manda
 * el prefijo de 5 caracteres del hash SHA-1, nunca la contraseña ni el hash
 * completo. Si la API falla o no responde, no bloqueamos el alta/cambio de
 * contraseña por eso — es una capa extra, no la única defensa.
 */
async function apareceEnFiltraciones(password: string): Promise<boolean> {
  try {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefijo = sha1.slice(0, 5);
    const sufijo = sha1.slice(5);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefijo}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;

    const texto = await res.text();
    return texto.split('\n').some((linea) => linea.split(':')[0].trim() === sufijo);
  } catch (e) {
    console.error('No se pudo consultar HaveIBeenPwned (se ignora, no bloquea):', e);
    return false;
  }
}

/** Devuelve un mensaje de error si la contraseña no cumple la política, o null si es válida. */
export async function validarPassword(password: string, datosUsuario: string[] = []): Promise<string | null> {
  if (password.length < LARGO_MINIMO) {
    return `La contraseña debe tener al menos ${LARGO_MINIMO} caracteres`;
  }

  const resultado = zxcvbn(password, datosUsuario);
  if (resultado.score < SCORE_MINIMO) {
    const sugerencia = resultado.feedback.warning || resultado.feedback.suggestions[0];
    return sugerencia ? `Contraseña demasiado predecible: ${sugerencia}` : 'Contraseña demasiado predecible, elegí una más difícil de adivinar';
  }

  if (await apareceEnFiltraciones(password)) {
    return 'Esta contraseña apareció en filtraciones de datos conocidas. Elegí otra.';
  }

  return null;
}
