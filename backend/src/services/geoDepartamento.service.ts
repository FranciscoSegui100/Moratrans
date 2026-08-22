import { query } from '../config/db';

/** Anillo exterior de un polígono: lista de puntos [lng, lat]. */
type Anillo = [number, number][];

/**
 * Ray casting (algoritmo par-impar): ¿el punto (lat,lng) cae dentro del
 * anillo? Sin dependencias externas ni llamadas a servicios pagos — los
 * polígonos ya están guardados en tarifas_departamento.limite_geografico
 * (ver migración 0025), descargados una única vez desde OpenStreetMap.
 */
function puntoEnPoligono(lat: number, lng: number, anillo: Anillo): boolean {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i];
    const [xj, yj] = anillo[j];
    const cruzaLado = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (cruzaLado) dentro = !dentro;
  }
  return dentro;
}

/**
 * ¿El punto compartido por el cliente cae dentro del polígono del
 * departamento que cotizó? `null` = ese departamento no tiene polígono
 * cargado todavía — no hay nada que validar, no bloquea el flujo.
 */
export async function estaDentroDeDepartamento(
  lat: number,
  lng: number,
  departamento: string,
): Promise<boolean | null> {
  const [fila] = await query<{ limite_geografico: Anillo | null }>(
    'SELECT limite_geografico FROM tarifas_departamento WHERE departamento = $1',
    [departamento],
  );
  if (!fila?.limite_geografico) return null;
  return puntoEnPoligono(lat, lng, fila.limite_geografico);
}

/**
 * ¿A cuál de los departamentos con polígono cargado pertenece este punto?
 * Se usa cuando `estaDentroDeDepartamento` da `false`, para poder ofrecerle
 * al cliente el departamento correcto en vez de solo avisar que algo no
 * coincide. `null` = no cae dentro de ninguno de los que tenemos mapeados.
 */
export async function detectarDepartamento(lat: number, lng: number): Promise<string | null> {
  const filas = await query<{ departamento: string; limite_geografico: Anillo }>(
    `SELECT departamento, limite_geografico FROM tarifas_departamento
      WHERE limite_geografico IS NOT NULL AND activo = TRUE`,
  );
  for (const fila of filas) {
    if (puntoEnPoligono(lat, lng, fila.limite_geografico)) return fila.departamento;
  }
  return null;
}

/**
 * Heurística de texto libre (sin GPS, no se puede geocodificar gratis): si
 * el cliente escribió el nombre de OTRO departamento activo dentro de la
 * dirección, es una señal de que puede haberse equivocado al elegir el
 * departamento de la cotización. No bloquea nada — solo agrega un aviso a
 * la confirmación de dirección.
 */
export async function departamentoMencionadoDistinto(
  texto: string,
  departamentoSeleccionado: string,
): Promise<string | null> {
  const normalizar = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const t = normalizar(texto);
  const selNorm = normalizar(departamentoSeleccionado);

  const filas = await query<{ departamento: string }>(
    'SELECT departamento FROM tarifas_departamento WHERE activo = TRUE',
  );
  for (const { departamento } of filas) {
    const dNorm = normalizar(departamento);
    if (dNorm !== selNorm && t.includes(dNorm)) return departamento;
  }
  return null;
}
