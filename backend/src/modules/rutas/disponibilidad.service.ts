/**
 * Regla de disponibilidad de contenedores de una ruta: un contenedor
 * liberado en la parada N (por retiro, o la mitad "retira" de un recambio)
 * solo puede asignarse a una parada M > N si hay una parada de vaciado entre
 * medio. Algoritmo puro (sin DB) — lo usan tanto `GET /rutas/:id` (para
 * poblar los selects del frontend mientras se arma la ruta) como
 * `POST /rutas/:id/confirmar` (revalidación final con datos frescos).
 */

export interface ParadaSimulada {
  orden: number;
  tipoParada: 'viaje' | 'vaciado';
  /** Solo si tipoParada === 'viaje'. */
  viajeTipo?: 'entrega' | 'retiro';
  contenedorNumero?: string | null;
}

export interface ResultadoDisponibilidad {
  /** Para cada `orden` de una parada de entrega (o la mitad-entrega de un recambio): los contenedores asignables ahí. */
  porOrden: Map<number, string[]>;
  /** En qué `orden` se liberó cada contenedor (por retiro), para reservarParaEntrega. */
  liberadosPor: Map<string, number>;
}

const PRIORIDAD_VIAJE_TIPO: Record<'entrega' | 'retiro', number> = { entrega: 0, retiro: 1 };

export function simularDisponibilidad(
  paradas: ParadaSimulada[],
  disponiblesAlInicio: string[],
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
  const pendientesDeVaciar = new Set<string>();
  const liberadosPor = new Map<string, number>();
  const porOrden = new Map<number, string[]>();

  for (const parada of ordenadas) {
    if (parada.tipoParada === 'vaciado') {
      // Libera TODO el set pendiente acumulado hasta acá — no un
      // contenedor puntual, tal como pide la regla de negocio.
      for (const numero of pendientesDeVaciar) disponibles.add(numero);
      pendientesDeVaciar.clear();
      continue;
    }

    if (parada.viajeTipo === 'retiro') {
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
    // las opciones válidas para ESTA parada, resuelta o no todavía.
    porOrden.set(parada.orden, [...disponibles]);
    if (parada.contenedorNumero) disponibles.delete(parada.contenedorNumero);
  }

  return { porOrden, liberadosPor };
}
