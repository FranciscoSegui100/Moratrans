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
});
