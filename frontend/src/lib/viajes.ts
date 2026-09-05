/**
 * Helpers de viajes compartidos por el panel (tablero de Viajes, y a futuro
 * la bolsa de Rutas, que hoy tiene su propia versión de esto).
 */

/**
 * Un recambio son dos filas de `viajes` —una 'entrega' del vacío que se deja
 * y una 'retiro' del lleno que se lleva— unidas por `grupo_id`. En el panel
 * se muestran como una sola visita. `agruparVisitas` toma una lista plana y
 * la colapsa: los viajes sueltos quedan con un solo elemento, el par de un
 * recambio con dos. Mismo criterio que agruparPendientes() en Rutas.tsx.
 */
export interface ViajeAgrupable {
  id: string;
  tipo: 'entrega' | 'retiro';
  grupo_id: string | null;
}

export interface Visita<T extends ViajeAgrupable> {
  /** grupo_id del recambio, o el id del viaje suelto — sirve de key en React. */
  key: string;
  grupoId: string | null;
  viajes: T[];
  entrega?: T;
  retiro?: T;
}

export function agruparVisitas<T extends ViajeAgrupable>(viajes: T[]): Visita<T>[] {
  const porGrupo = new Map<string, Visita<T>>();
  const orden: Visita<T>[] = [];
  for (const v of viajes) {
    if (v.grupo_id) {
      let visita = porGrupo.get(v.grupo_id);
      if (!visita) {
        visita = { key: v.grupo_id, grupoId: v.grupo_id, viajes: [] };
        porGrupo.set(v.grupo_id, visita);
        orden.push(visita);
      }
      visita.viajes.push(v);
      if (v.tipo === 'entrega') visita.entrega = v;
      else visita.retiro = v;
    } else {
      const visita: Visita<T> = { key: v.id, grupoId: null, viajes: [v] };
      if (v.tipo === 'entrega') visita.entrega = v;
      else visita.retiro = v;
      orden.push(visita);
    }
  }
  return orden;
}

/** Hoy en formato YYYY-MM-DD (mismo criterio de zona horaria que Rutas.tsx). */
export function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Suma (o resta, con negativo) días a una fecha YYYY-MM-DD y la devuelve YYYY-MM-DD. */
export function sumarDias(fechaISO: string, dias: number): string {
  const [a, m, d] = fechaISO.slice(0, 10).split('-').map(Number);
  const fecha = new Date(a, m - 1, d);
  fecha.setDate(fecha.getDate() + dias);
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  return `${fecha.getFullYear()}-${mm}-${dd}`;
}

/** ¿`fecha` (YYYY-MM-DD, o ISO larga) cae dentro de [desde, hasta] inclusive? Comparación de strings ISO. */
export function fechaEnRango(fecha: string, desde: string, hasta: string): boolean {
  const f = fecha.slice(0, 10);
  return f >= desde && f <= hasta;
}
