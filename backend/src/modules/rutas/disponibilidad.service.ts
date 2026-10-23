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
  /** Solo si tipoParada === 'viaje': el chofer ya la marcó hecha (completada_en no es null). */
  completada?: boolean;
  /**
   * Solo si viajeTipo === 'retiro': el contenedor YA se vació de verdad
   * (contenedores.estado ya no es 'retirado') aunque esta ruta no tenga
   * ninguna parada de 'vaciado' que lo libere — pasa cuando el chofer lo
   * vacía por WhatsApp sin pasar por una parada linkeada de esta ruta (ver
   * rutas.routes.ts). Sin esto, la simulación lo daba por "pendiente de
   * vaciar" para siempre y las entregas siguientes de la MISMA ruta se
   * quedaban sin contenedores para ofrecer aunque en la realidad sí había
   * stock (bug real: "dice que no hay stock habiendo contenedores
   * disponibles").
   */
  yaVaciadoEnRealidad?: boolean;
}

export interface CapacidadCamion {
  /** Máximo de contenedores llenos a bordo sin vaciar. Default: 1. */
  llenos: number;
  /** Máximo de contenedores vacíos a bordo. Default: 6. */
  vacios: number;
}

export const CAPACIDAD_CAMION_DEFAULT: CapacidadCamion = { llenos: 1, vacios: 6 };

export interface AdvertenciaCapacidad {
  orden: number;
  tipo: 'lleno_sin_vaciar' | 'vacios_exceso';
  mensaje: string;
}

export interface EstadoCamionPaso {
  orden: number;
  llenos: number;
  vacios: number;
  capacidad: CapacidadCamion;
}

export interface ResultadoDisponibilidad {
  /** Para cada `orden` de una parada de entrega (o la mitad-entrega de un recambio): los contenedores asignables ahí. */
  porOrden: Map<number, string[]>;
  /** En qué `orden` se liberó cada contenedor (por retiro), para reservarParaEntrega. */
  liberadosPor: Map<string, number>;
  /** Avisos de capacidad del camión — no bloquean el armado de la ruta. */
  advertencias: AdvertenciaCapacidad[];
  /** Estado de carga física del camión en cada parada ordenada. */
  estadoCamionPorOrden: Map<number, EstadoCamionPaso>;
  /** Estado de carga inicial al salir del depósito antes de la parada 1. */
  estadoCamionInicial: { llenos: number; vacios: number; capacidad: CapacidadCamion };
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
  // Contenedores ya tomados por ALGUNA parada de entrega PENDIENTE de esta
  // ruta: no se pueden ofrecer en ninguna otra parada (el índice único
  // ux_viajes_activo_por_tipo admite un solo viaje activo por contenedor+tipo).
  // El `for` de abajo solo saca un contenedor DESPUÉS de su parada, así que sin
  // esto una parada de orden menor lo seguía viendo disponible y al asignarlo
  // se creaba una segunda entrega activa para el mismo contenedor.
  // Una entrega ya COMPLETADA no cuenta acá: ese contenedor puede volver
  // (retiro + vaciado) y empezar un ciclo nuevo más adelante en la misma
  // ruta — bloquearlo para siempre por un uso ya terminado es el mismo bug
  // real que el de yaVaciadoEnRealidad (ver arriba), solo que en la otra
  // punta de la cadena entrega→retiro→vaciado→entrega.
  const asignadosAEntrega = new Set(
    ordenadas
      .filter((p) => p.tipoParada === 'viaje' && p.viajeTipo !== 'retiro' && p.contenedorNumero && !p.completada)
      .map((p) => p.contenedorNumero as string),
  );
  const pendientesDeVaciar = new Set<string>();
  const liberadosPor = new Map<string, number>();
  const porOrden = new Map<number, string[]>();
  const advertencias: AdvertenciaCapacidad[] = [];
  const estadoCamionPorOrden = new Map<number, EstadoCamionPaso>();

  // Vacíos físicamente a bordo de ESTE camión para ESTA ruta — no confundir
  // con `disponibles`, que es el stock del depósito ofrecido como candidato
  // en cada parada de entrega (puede incluir contenedores que nunca suben a
  // este camión). Arranca en la cantidad de entregas de la ruta (cada una
  // necesita cargar un vacío de salida) y se repone con lo que se vacía en
  // una parada de vaciado; una entrega lo baja al dejarlo en destino.
  const vaciosIniciales = ordenadas.filter((p) => p.tipoParada === 'viaje' && p.viajeTipo !== 'retiro').length;
  let vaciosABordo = vaciosIniciales;

  const estadoCamionInicial = {
    llenos: 0,
    vacios: vaciosIniciales,
    capacidad,
  };

  const chequearVacios = (orden: number) => {
    if (vaciosABordo > capacidad.vacios) {
      advertencias.push({
        orden,
        tipo: 'vacios_exceso',
        mensaje: `Hay ${vaciosABordo} contenedores vacíos a bordo, por encima de la capacidad del camión (${capacidad.vacios}).`,
      });
    }
  };
  chequearVacios(0); // estado al arrancar la ruta, antes de la primera parada

  for (const parada of ordenadas) {
    if (parada.tipoParada === 'vaciado') {
      // Libera TODO el set pendiente acumulado hasta acá — no un
      // contenedor puntual, tal como pide la regla de negocio.
      for (const numero of pendientesDeVaciar) disponibles.add(numero);
      vaciosABordo += pendientesDeVaciar.size;
      pendientesDeVaciar.clear();
      chequearVacios(parada.orden);
      estadoCamionPorOrden.set(parada.orden, {
        orden: parada.orden,
        llenos: pendientesDeVaciar.size,
        vacios: vaciosABordo,
        capacidad,
      });
      continue;
    }

    if (parada.viajeTipo === 'retiro') {
      // Ya se vació de verdad por otro canal (ej. el chofer por WhatsApp,
      // sin pasar por una parada de vaciado de ESTA ruta): vuelve a estar
      // disponible de una, no hace falta esperar un 'vaciado' en la
      // secuencia ni cuenta como "lleno a bordo sin vaciar".
      if (parada.contenedorNumero && parada.yaVaciadoEnRealidad) {
        disponibles.add(parada.contenedorNumero);
        liberadosPor.set(parada.contenedorNumero, parada.orden);
        vaciosABordo += 1;
        chequearVacios(parada.orden);
        continue;
      }
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
      estadoCamionPorOrden.set(parada.orden, {
        orden: parada.orden,
        llenos: pendientesDeVaciar.size,
        vacios: vaciosABordo,
        capacidad,
      });
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
    vaciosABordo -= 1; // nunca puede superar la capacidad acá: solo baja hasta el próximo vaciado

    estadoCamionPorOrden.set(parada.orden, {
      orden: parada.orden,
      llenos: pendientesDeVaciar.size,
      vacios: vaciosABordo,
      capacidad,
    });
  }

  return { porOrden, liberadosPor, advertencias, estadoCamionPorOrden, estadoCamionInicial };
}
