import { describe, it, expect, vi, afterEach } from 'vitest';
import { proximosDiasHabiles, formatearFechaLarga } from '../../src/services/diasHabiles.service';

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
});
