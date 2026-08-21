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

    it('advierte "vacios_exceso" desde 3 vacíos a bordo, aunque no se supere la capacidad', () => {
      const { advertencias } = simularDisponibilidad([], ['A', 'B', 'C']);
      expect(advertencias).toHaveLength(1);
      expect(advertencias[0]).toMatchObject({ orden: 0, tipo: 'vacios_exceso' });
      expect(advertencias[0].mensaje).not.toMatch(/por encima/);
    });

    it('advierte "vacios_exceso" con mensaje distinto al superar la capacidad del camión', () => {
      const { advertencias } = simularDisponibilidad([], ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
      expect(advertencias).toHaveLength(1);
      expect(advertencias[0]).toMatchObject({ orden: 0, tipo: 'vacios_exceso' });
      expect(advertencias[0].mensaje).toMatch(/por encima/);
    });

    it('menos de 3 vacíos a bordo no genera advertencia', () => {
      const { advertencias } = simularDisponibilidad([], ['A', 'B']);
      expect(advertencias).toHaveLength(0);
    });

    it('un vaciado que suma vacíos a bordo por encima del umbral también advierte', () => {
      const paradas: ParadaSimulada[] = [
        { orden: 1, tipoParada: 'viaje', viajeTipo: 'retiro', contenedorNumero: 'A' },
        { orden: 2, tipoParada: 'vaciado' },
      ];
      const { advertencias } = simularDisponibilidad(paradas, ['X', 'Y']);
      expect(advertencias.some((a) => a.orden === 2 && a.tipo === 'vacios_exceso')).toBe(true);
    });
  });
});
