import { describe, it, expect } from 'vitest';
import { calcularAvisosConfirmacion, ParadaParaAviso } from '../../../src/modules/rutas/avisosRuta.service';

describe('calcularAvisosConfirmacion (QA Matrix - Rutas y Clientes)', () => {
  it('caso real de bug: consolida recambio (entrega + retiro) en 1 solo aviso de tipo recambio', () => {
    // Exacto escenario que disparó el error del usuario:
    // Un recambio en Laguna del Rosario 1123 (entrega + retiro compartiendo grupo_id),
    // más un retiro adicional en Laguna del Rosario, Vistalba.
    const paradas: ParadaParaAviso[] = [
      {
        cliente_telefono: '+5492615551123',
        grupo_id: 'grupo-recambio-1',
        tipo: 'entrega',
        destino_direccion: 'Laguna del Rosario 1123',
      },
      {
        cliente_telefono: '+5492615551123',
        grupo_id: 'grupo-recambio-1',
        tipo: 'retiro',
        destino_direccion: 'Laguna del Rosario 1123',
      },
      {
        cliente_telefono: '+5492615551123',
        grupo_id: null,
        tipo: 'retiro',
        destino_direccion: 'Laguna del Rosario, Vistalba',
      },
    ];

    const avisos = calcularAvisosConfirmacion(paradas, '2026-10-30');

    // Debe generar exactamente 2 avisos (NO 3):
    // 1 de tipo 'recambio' para Laguna del Rosario 1123
    // 1 de tipo 'retiro' para Laguna del Rosario, Vistalba
    expect(avisos).toHaveLength(2);

    expect(avisos[0]).toEqual({
      clienteTelefono: '+5492615551123',
      tipo: 'recambio',
      destinoDireccion: 'Laguna del Rosario 1123',
      fecha: '2026-10-30',
    });

    expect(avisos[1]).toEqual({
      clienteTelefono: '+5492615551123',
      tipo: 'retiro',
      destinoDireccion: 'Laguna del Rosario, Vistalba',
      fecha: '2026-10-30',
    });
  });

  it('consolida recambio aun si la parada de retiro está primera en el listado', () => {
    const paradas: ParadaParaAviso[] = [
      {
        cliente_telefono: '+5492615559999',
        grupo_id: 'grupo-recambio-2',
        tipo: 'retiro',
        destino_direccion: 'San Lorenzo 450',
      },
      {
        cliente_telefono: '+5492615559999',
        grupo_id: 'grupo-recambio-2',
        tipo: 'entrega',
        destino_direccion: 'San Lorenzo 450',
      },
    ];

    const avisos = calcularAvisosConfirmacion(paradas, '2026-10-30');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].tipo).toBe('recambio');
  });

  it('deduplica si por error del operador se confirman 2 entregas idénticas al mismo cliente y destino', () => {
    const paradas: ParadaParaAviso[] = [
      {
        cliente_telefono: '+5492615558888',
        grupo_id: null,
        tipo: 'entrega',
        destino_direccion: 'Rivadavia 100',
      },
      {
        cliente_telefono: '+5492615558888',
        grupo_id: null,
        tipo: 'entrega',
        destino_direccion: 'Rivadavia 100', // duplicada idéntica
      },
    ];

    const avisos = calcularAvisosConfirmacion(paradas, '2026-10-30');
    expect(avisos).toHaveLength(1);
  });

  it('permite 2 entregas si los destinos son diferentes para el mismo cliente', () => {
    const paradas: ParadaParaAviso[] = [
      {
        cliente_telefono: '+5492615558888',
        grupo_id: null,
        tipo: 'entrega',
        destino_direccion: 'Obra Calle 1',
      },
      {
        cliente_telefono: '+5492615558888',
        grupo_id: null,
        tipo: 'entrega',
        destino_direccion: 'Obra Calle 2',
      },
    ];

    const avisos = calcularAvisosConfirmacion(paradas, '2026-10-30');
    expect(avisos).toHaveLength(2);
    expect(avisos[0].destinoDireccion).toBe('Obra Calle 1');
    expect(avisos[1].destinoDireccion).toBe('Obra Calle 2');
  });

  it('ignora completamente paradas sin teléfono de cliente registrado', () => {
    const paradas: ParadaParaAviso[] = [
      {
        cliente_telefono: null,
        grupo_id: null,
        tipo: 'entrega',
        destino_direccion: 'Sin teléfono',
      },
      {
        cliente_telefono: '',
        grupo_id: null,
        tipo: 'retiro',
        destino_direccion: 'Vacío',
      },
    ];

    const avisos = calcularAvisosConfirmacion(paradas, '2026-10-30');
    expect(avisos).toHaveLength(0);
  });
});
