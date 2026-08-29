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
 * ¿A cuál de los departamentos con polígono cargado pertenece este punto?
 * Se usa para ubicar al cliente en el departamento correcto a partir de su
 * ubicación compartida. `null` = no cae dentro de ninguno de los que tenemos
 * mapeados.
 */
export async function detectarDepartamento(lat: number, lng: number): Promise<string | null> {
  const filas = await query<{ departamento: string; limite_geografico: Anillo }>(
    `SELECT departamento, limite_geografico FROM tarifas_departamento
      WHERE limite_geografico IS NOT NULL AND activo = TRUE
      ORDER BY prioridad ASC, departamento ASC`,
  );
  for (const fila of filas) {
    if (puntoEnPoligono(lat, lng, fila.limite_geografico)) return fila.departamento;
  }
  return null;
}

const RADIO_TIERRA_KM = 6371;

function distanciaHaversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const aRad = (Math.PI / 180) * (lat2 - lat1);
  const bRad = (Math.PI / 180) * (lng2 - lng1);
  const h =
    Math.sin(aRad / 2) ** 2 +
    Math.cos((Math.PI / 180) * lat1) * Math.cos((Math.PI / 180) * lat2) * Math.sin(bRad / 2) ** 2;
  return RADIO_TIERRA_KM * 2 * Math.asin(Math.sqrt(h));
}

/**
 * Caso borde "punto fuera de todas las zonas": en vez de inventar un precio,
 * se le avisa al cliente qué tan lejos está de la base más cercana (depósito
 * o vaciadero con coordenadas cargadas, ver migración 0029) antes de
 * derivarlo a un asesor. `null` si no hay ninguna ubicación propia con
 * lat/lng cargado todavía (no bloquea el resto del flujo, solo no se puede
 * mostrar la distancia).
 */
export async function distanciaALaBaseMasCercana(
  lat: number,
  lng: number,
): Promise<{ nombre: string; distanciaKm: number } | null> {
  const bases = await query<{ nombre: string; lat: number; lng: number }>(
    `SELECT nombre, lat, lng FROM ubicaciones WHERE activo = TRUE AND lat IS NOT NULL AND lng IS NOT NULL`,
  );
  if (bases.length === 0) return null;

  let masCercana = bases[0];
  let distanciaMin = distanciaHaversineKm(lat, lng, bases[0].lat, bases[0].lng);
  for (const base of bases.slice(1)) {
    const d = distanciaHaversineKm(lat, lng, base.lat, base.lng);
    if (d < distanciaMin) {
      distanciaMin = d;
      masCercana = base;
    }
  }
  return { nombre: masCercana.nombre, distanciaKm: Math.round(distanciaMin * 10) / 10 };
}
