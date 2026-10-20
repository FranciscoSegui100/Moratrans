import { describe, it, expect } from 'vitest';
import { simularDisponibilidad, ParadaSimulada } from '../../../src/modules/rutas/disponibilidad.service';

describe('simularDisponibilidad', () => {
  it('un contenedor disponible desde el inicio queda ofrecido en la primera entrega', () => {
    const paradas: ParadaSimulada[] = [
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: null },
    ];
    const { porOrden } = simularDisponibilidad(paradas, ['MSKU001']);
    expect(porOrden.get(1)).toEqual(['MSKU001']);
  });

  it('un contenedor liberado por retiro + vaciado posterior queda disponible después del vaciado', () => {
    const paradas: ParadaSimulada[] = [
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'MSKU001' },
      { orden: 2, tipoParada: 'vaciado' },
      { orden: 3, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: null },
    ];
    const { porOrden, liberadosPor } = simularDisponibilidad(paradas, []);
    expect(porOrden.get(3)).toEqual(['MSKU001']);
    expect(liberadosPor.get('MSKU001')).toBe(1);
  });

  it('un contenedor liberado por retiro SIN vaciado posterior no aparece disponible', () => {
    const paradas: ParadaSimulada[] = [
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'MSKU001' },
      { orden: 2, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: null },
    ];
    const { porOrden } = simularDisponibilidad(paradas, []);
    expect(porOrden.get(2)).toEqual([]);
  });

  it('un retiro ya vaciado en la realidad (yaVaciadoEnRealidad) queda disponible sin necesitar una parada de vaciado', () => {
    // Bug real: el chofer vació el contenedor por WhatsApp (fuera de esta
    // ruta, sin una parada de vaciado linkeada) y el panel seguía diciendo
    // "sin stock" para la siguiente entrega de la misma ruta.
    const paradas: ParadaSimulada[] = [
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'MSKU001', yaVaciadoEnRealidad: true },
      { orden: 2, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: null },
    ];
    const { porOrden, liberadosPor } = simularDisponibilidad(paradas, []);
    expect(porOrden.get(2)).toEqual(['MSKU001']);
    expect(liberadosPor.get('MSKU001')).toBe(1);
  });

  it('un retiro ya vaciado en la realidad no cuenta para la advertencia de capacidad de llenos', () => {
    const paradas: ParadaSimulada[] = [
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'A', yaVaciadoEnRealidad: true },
      { orden: 2, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'B' },
    ];
    const { advertencias } = simularDisponibilidad(paradas, []);
    expect(advertencias.filter((a) => a.tipo === 'lleno_sin_vaciar')).toHaveLength(0);
  });

  it('un contenedor que completó entrega→retiro→vaciado en esta misma ruta queda libre para una entrega posterior', () => {
    // Bug real: entrega de CAFE123 ya finalizada por el chofer, después
    // retiro de CAFE123 ya vaciado en la realidad (yaVaciadoEnRealidad), y
    // una tercera parada (otra entrega, sin contenedor todavía) en la MISMA
    // ruta — el panel decía "sin stock" aunque CAFE123 ya había completado
    // todo el ciclo y estaba libre de nuevo.
    const paradas: ParadaSimulada[] = [
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: 'CAFE123', completada: true },
      { orden: 2, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'CAFE123', yaVaciadoEnRealidad: true },
      { orden: 3, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: null },
    ];
    const { porOrden } = simularDisponibilidad(paradas, ['CAFE123']);
    expect(porOrden.get(3)).toEqual(['CAFE123']);
  });

  it('un recambio comparte orden: la mitad entrega ve lo disponible, la mitad retiro deja pendiente de vaciar', () => {
    const paradas: ParadaSimulada[] = [
      // Insertadas en el orden "menos favorable" a propósito (retiro antes
      // que entrega en el array de entrada) para probar que el algoritmo
      // reordena internamente y no depende del orden de llegada.
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'LLENO1' },
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: null },
    ];
    const { porOrden, liberadosPor } = simularDisponibilidad(paradas, ['VACIO1']);
    expect(porOrden.get(1)).toEqual(['VACIO1']);
    expect(liberadosPor.get('LLENO1')).toBe(1);
  });

  it('un contenedor elegido en una entrega se saca del set para las paradas siguientes', () => {
    const paradas: ParadaSimulada[] = [
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: 'VACIO1' },
      { orden: 2, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: null },
    ];
    const { porOrden } = simularDisponibilidad(paradas, ['VACIO1', 'VACIO2']);
    expect(porOrden.get(1)).toEqual(['VACIO1', 'VACIO2']);
    expect(porOrden.get(2)).toEqual(['VACIO2']);
  });

  it('un contenedor ya asignado a una entrega posterior no se ofrece en una entrega anterior', () => {
    const paradas: ParadaSimulada[] = [
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: null },
      { orden: 2, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: 'VACIO1' },
    ];
    const { porOrden } = simularDisponibilidad(paradas, ['VACIO1', 'VACIO2']);
    // VACIO1 ya es de la parada 2 — la 1 solo puede usar VACIO2.
    expect(porOrden.get(1)).toEqual(['VACIO2']);
    // La parada 2 igual se ve a sí misma (el select del panel muestra el valor actual).
    expect(porOrden.get(2)).toEqual(['VACIO1', 'VACIO2']);
  });

  it('una parada de vaciado libera TODO el set pendiente, no un contenedor puntual', () => {
    const paradas: ParadaSimulada[] = [
      { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'A' },
      { orden: 2, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'B' },
      { orden: 3, tipoParada: 'vaciado' },
      { orden: 4, tipoParada: 'viaje', viajeTipo: 'entrega', contenedorNumero: null },
    ];
    const { porOrden } = simularDisponibilidad(paradas, []);
    expect(porOrden.get(4)?.sort()).toEqual(['A', 'B']);
  });

  describe('capacidad del camión', () => {
    it('un segundo retiro sin vaciado de por medio advierte "lleno_sin_vaciar" (capacidad default: 1)', () => {
      const paradas: ParadaSimulada[] = [
        { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'A' },
        { orden: 2, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'B' },
      ];
      const { advertencias } = simularDisponibilidad(paradas, []);
      expect(advertencias).toHaveLength(1);
      expect(advertencias[0]).toMatchObject({ orden: 2, tipo: 'lleno_sin_vaciar' });
    });

    it('un vaciado entre dos retiros no genera advertencia de lleno sin vaciar', () => {
      const paradas: ParadaSimulada[] = [
        { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'A' },
        { orden: 2, tipoParada: 'vaciado' },
        { orden: 3, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'B' },
      ];
      const { advertencias } = simularDisponibilidad(paradas, []);
      expect(advertencias.filter((a) => a.tipo === 'lleno_sin_vaciar')).toHaveLength(0);
    });

    it('una capacidad de llenos mayor a 1 tolera varios retiros sin vaciado', () => {
      const paradas: ParadaSimulada[] = [
        { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'A' },
        { orden: 2, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'B' },
      ];
      const { advertencias } = simularDisponibilidad(paradas, [], { llenos: 2, vacios: 6 });
      expect(advertencias.filter((a) => a.tipo === 'lleno_sin_vaciar')).toHaveLength(0);
    });

    it('no advierte mientras no se supere la capacidad de vacíos', () => {
      const { advertencias } = simularDisponibilidad([], ['A', 'B', 'C', 'D', 'E', 'F']);
      expect(advertencias).toHaveLength(0);
    });

    it('el stock del depósito NO cuenta como "a bordo": una ruta sin entregas no advierte aunque haya mucho stock disponible', () => {
      // Bug real confirmado en producción: una ruta de una sola parada mostraba
      // "70 vacíos a bordo" porque se comparaba contra el stock TOTAL del
      // depósito, no contra lo que esa ruta puntual carga.
      const { advertencias } = simularDisponibilidad([], ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
      expect(advertencias.filter((a) => a.tipo === 'vacios_exceso')).toHaveLength(0);
    });

    it('advierte "vacios_exceso" cuando la ruta tiene más entregas que la capacidad del camión', () => {
      const paradas: ParadaSimulada[] = Array.from({ length: 7 }, (_, i) => ({
        orden: i + 1,
        tipoParada: 'viaje' as const,
        viajeTipo: 'entrega' as const,
        contenedorNumero: null,
      }));
      const { advertencias } = simularDisponibilidad(paradas, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
      expect(advertencias[0]).toMatchObject({ orden: 0, tipo: 'vacios_exceso' });
      expect(advertencias[0].mensaje).toMatch(/por encima/);
    });

    it('un vaciado que repone vacíos por encima de la capacidad también advierte', () => {
      const paradas: ParadaSimulada[] = [
        ...Array.from({ length: 7 }, (_, i) => ({
          orden: i + 1,
          tipoParada: 'viaje' as const,
          viajeTipo: 'retiro' as const,
          contenedorNumero: String.fromCharCode(65 + i),
        })),
        { orden: 8, tipoParada: 'vaciado' as const },
      ];
      const { advertencias } = simularDisponibilidad(paradas, []);
      expect(advertencias.some((a) => a.orden === 8 && a.tipo === 'vacios_exceso')).toBe(true);
    });
  });
});
