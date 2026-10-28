import { describe, it, expect, vi, afterEach } from 'vitest';
import { proximosDiasHabiles, formatearFechaLarga, esFinDeSemana } from '../../src/services/diasHabiles.service';

describe('diasHabiles.service', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ofrece "Hoy" si son antes de las 15hs en Mendoza', () => {
    // 14:00 Mendoza = 17:00 UTC (miércoles 21 de octubre 2026)
    vi.setSystemTime(new Date('2026-10-21T17:00:00.000Z'));

    const dias = proximosDiasHabiles(3, { incluirHoy: true });
    expect(dias.length).toBe(3);
    expect(dias[0].fecha).toBe('2026-10-21');
    expect(dias[0].etiqueta).toContain('Hoy');
  });

  it('NO ofrece "Hoy" si son las 15hs o más en Mendoza (pasa al siguiente día hábil)', () => {
    // 19:00 Mendoza = 22:00 UTC (miércoles 21 de octubre 2026)
    vi.setSystemTime(new Date('2026-10-21T22:00:00.000Z'));

    const dias = proximosDiasHabiles(3, { incluirHoy: true });
    expect(dias.length).toBe(3);
    expect(dias[0].fecha).toBe('2026-10-22'); // Jueves 22
    expect(dias[0].etiqueta).not.toContain('Hoy');
    expect(dias[0].etiqueta).toContain('jueves');
  });

  it('formatea la fecha en formato largo legible', () => {
    expect(formatearFechaLarga('2026-10-22')).toBe('jueves 22 de octubre');
  });

  describe('esFinDeSemana', () => {
    it('detecta correctamente sábado en horario de Mendoza', () => {
      // Sábado 24 de octubre 2026, 12:00 Mendoza (15:00 UTC)
      vi.setSystemTime(new Date('2026-10-24T15:00:00.000Z'));
      expect(esFinDeSemana()).toBe(true);
    });

    it('detecta correctamente domingo a última hora en horario de Mendoza', () => {
      // Domingo 25 de octubre 2026, 23:30 Mendoza (lunes 26 a las 02:30 UTC)
      vi.setSystemTime(new Date('2026-10-26T02:30:00.000Z'));
      expect(esFinDeSemana()).toBe(true);
    });

    it('devuelve false para viernes a la noche en Mendoza', () => {
      // Viernes 23 de octubre 2026, 21:00 Mendoza (sábado 24 a las 00:00 UTC)
      vi.setSystemTime(new Date('2026-10-24T00:00:00.000Z'));
      expect(esFinDeSemana()).toBe(false);
    });

    it('devuelve false para lunes a la mañana en Mendoza', () => {
      // Lunes 26 de octubre 2026, 08:00 Mendoza (11:00 UTC)
      vi.setSystemTime(new Date('2026-10-26T11:00:00.000Z'));
      expect(esFinDeSemana()).toBe(false);
    });
  });
});
