/**
 * Regla de disponibilidad de contenedores de una ruta: un contenedor
 * liberado en la parada N (por retiro, o la mitad "retira" de un recambio)
 * solo puede asignarse a una parada M > N si hay una parada de vaciado entre
 * medio. Algoritmo puro (sin DB) — lo usan tanto `GET /rutas/:id` (para
 * poblar los selects del frontend mientras se arma la ruta) como
 * `POST /rutas/:id/confirmar` (revalidación final con datos frescos).
 *
 * Además valida (a título de ADVERTENCIA, nunca bloquea) la capacidad física
 * del camión: a lo sumo un lleno a bordo sin vaciar, y un tope de vacíos
 * transportados — ver reunión del 21/08.
 */

export interface ParadaSimulada {
  orden: number;
  tipoParada: 'viaje' | 'vaciado';
  /** Solo si tipoParada === 'viaje'. */
  viajeTipo?: 'entrega' | 'retiro';
  contenedorNumero?: string | null;
}

export interface CapacidadCamion {
  /** Máximo de contenedores llenos a bordo sin vaciar. Default: 1. */
  llenos: number;
  /** Máximo de contenedores vacíos a bordo. Default: 6. */
  vacios: number;
}

export const CAPACIDAD_CAMION_DEFAULT: CapacidadCamion = { llenos: 1, vacios: 6 };

/** A partir de cuántos vacíos a bordo se empieza a advertir (aunque no se supere la capacidad todavía). */
const UMBRAL_ADVERTENCIA_VACIOS = 3;

export interface AdvertenciaCapacidad {
  orden: number;
  tipo: 'lleno_sin_vaciar' | 'vacios_exceso';
  mensaje: string;
}

export interface ResultadoDisponibilidad {
  /** Para cada `orden` de una parada de entrega (o la mitad-entrega de un recambio): los contenedores asignables ahí. */
  porOrden: Map<number, string[]>;
  /** En qué `orden` se liberó cada contenedor (por retiro), para reservarParaEntrega. */
  liberadosPor: Map<string, number>;
  /** Avisos de capacidad del camión — no bloquean el armado de la ruta. */
  advertencias: AdvertenciaCapacidad[];
}

const PRIORIDAD_VIAJE_TIPO: Record<'entrega' | 'retiro', number> = { entrega: 0, retiro: 1 };

export function simularDisponibilidad(
  paradas: ParadaSimulada[],
  disponiblesAlInicio: string[],
  capacidad: CapacidadCamion = CAPACIDAD_CAMION_DEFAULT,
): ResultadoDisponibilidad {
  // Dentro del mismo `orden` (par de recambio), la mitad "entrega" se
  // resuelve antes que la "retiro" — no cambia el resultado (son
  // contenedores distintos) pero fija un orden determinístico.
  const ordenadas = [...paradas].sort((a, b) => {
    if (a.orden !== b.orden) return a.orden - b.orden;
    const pa = a.tipoParada === 'viaje' ? PRIORIDAD_VIAJE_TIPO[a.viajeTipo ?? 'entrega'] : -1;
    const pb = b.tipoParada === 'viaje' ? PRIORIDAD_VIAJE_TIPO[b.viajeTipo ?? 'entrega'] : -1;
    return pa - pb;
  });

  const disponibles = new Set(disponiblesAlInicio);
  // Contenedores ya tomados por ALGUNA parada de entrega de esta ruta: no se
  // pueden ofrecer en ninguna otra parada (el índice único
  // ux_viajes_activo_por_tipo admite un solo viaje activo por contenedor+tipo).
  // El `for` de abajo solo saca un contenedor DESPUÉS de su parada, así que sin
  // esto una parada de orden menor lo seguía viendo disponible y al asignarlo
  // se creaba una segunda entrega activa para el mismo contenedor.
  const asignadosAEntrega = new Set(
    ordenadas
      .filter((p) => p.tipoParada === 'viaje' && p.viajeTipo !== 'retiro' && p.contenedorNumero)
      .map((p) => p.contenedorNumero as string),
  );
  const pendientesDeVaciar = new Set<string>();
  const liberadosPor = new Map<string, number>();
  const porOrden = new Map<number, string[]>();
  const advertencias: AdvertenciaCapacidad[] = [];

  const chequearVacios = (orden: number) => {
    if (disponibles.size > capacidad.vacios) {
      advertencias.push({
        orden,
        tipo: 'vacios_exceso',
        mensaje: `Hay ${disponibles.size} contenedores vacíos a bordo, por encima de la capacidad del camión (${capacidad.vacios}).`,
      });
    } else if (disponibles.size >= UMBRAL_ADVERTENCIA_VACIOS) {
      advertencias.push({
        orden,
        tipo: 'vacios_exceso',
        mensaje: `Hay ${disponibles.size} contenedores vacíos a bordo — cerca del límite del camión (${capacidad.vacios}).`,
      });
    }
  };
  chequearVacios(0); // estado al arrancar la ruta, antes de la primera parada

  for (const parada of ordenadas) {
    if (parada.tipoParada === 'vaciado') {
      // Libera TODO el set pendiente acumulado hasta acá — no un
      // contenedor puntual, tal como pide la regla de negocio.
      for (const numero of pendientesDeVaciar) disponibles.add(numero);
      pendientesDeVaciar.clear();
      chequearVacios(parada.orden);
      continue;
    }

    if (parada.viajeTipo === 'retiro') {
      // Ya hay tantos llenos a bordo sin vaciar como la capacidad del camión:
      // esta parada de retiro/recambio es inválida hasta insertar un vaciado
      // antes. Se avisa igual (no se bloquea acá — el llamador decide).
      if (pendientesDeVaciar.size >= capacidad.llenos) {
        advertencias.push({
          orden: parada.orden,
          tipo: 'lleno_sin_vaciar',
          mensaje: `Parada ${parada.orden} (retiro): ya hay ${pendientesDeVaciar.size} lleno(s) a bordo sin vaciar (capacidad del camión: ${capacidad.llenos}) — insertá un vaciado antes.`,
        });
      }
      // Un contenedor recién retirado del cliente nunca estuvo "a bordo
      // disponible" — viene de 'entregado', no de 'disponible'. Solo queda
      // pendiente de vaciar hasta la próxima parada de vaciado.
      if (parada.contenedorNumero) {
        pendientesDeVaciar.add(parada.contenedorNumero);
        liberadosPor.set(parada.contenedorNumero, parada.orden);
      }
      continue;
    }

    // 'entrega' (o mitad-entrega de un recambio): expone el set actual como
    // las opciones válidas para ESTA parada, resuelta o no todavía — menos los
    // contenedores ya tomados por otra parada de entrega de la ruta (siempre se
    // deja el propio, para que el select del panel muestre el valor actual).
    porOrden.set(
      parada.orden,
      [...disponibles].filter((n) => n === parada.contenedorNumero || !asignadosAEntrega.has(n)),
    );
    if (parada.contenedorNumero) disponibles.delete(parada.contenedorNumero);
  }

  return { porOrden, liberadosPor, advertencias };
}
