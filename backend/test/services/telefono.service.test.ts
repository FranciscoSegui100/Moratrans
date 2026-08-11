import { describe, it, expect } from 'vitest';
import { normalizarDestinoWhatsApp, normalizarTelefonoAR } from '../../src/services/telefono.service';

describe('normalizarTelefonoAR', () => {
  it('normaliza un wa_id ya canónico (queda igual)', () => {
    expect(normalizarTelefonoAR('5492612062258')).toBe('5492612062258');
  });

  it('agrega el 549 si falta', () => {
    expect(normalizarTelefonoAR('2612062258')).toBe('5492612062258');
  });

  it('saca el 0 inicial (formato local)', () => {
    expect(normalizarTelefonoAR('02612062258')).toBe('5492612062258');
  });

  it('saca el 15 viejo pegado después del código de área', () => {
    expect(normalizarTelefonoAR('0261 15 2062258')).toBe('5492612062258');
  });

  it('saca el prefijo internacional 00', () => {
    expect(normalizarTelefonoAR('00542612062258')).toBe('5492612062258');
  });

  it('ignora espacios y guiones', () => {
    expect(normalizarTelefonoAR('261-206-2258')).toBe('5492612062258');
  });

  it('reconoce el código de área 11 (Buenos Aires) sin 15', () => {
    expect(normalizarTelefonoAR('01141234567')).toBe('5491141234567');
  });
});

describe('normalizarDestinoWhatsApp', () => {
  it('convierte un wa_id a formato clásico para envío', () => {
    expect(normalizarDestinoWhatsApp('5492612062258')).toBe('54261152062258');
  });

  it('no toca números que no son wa_id argentino (no arrancan con 549)', () => {
    expect(normalizarDestinoWhatsApp('19995551234')).toBe('19995551234');
  });

  it('es inversa de normalizarTelefonoAR para un número reconocido', () => {
    const waId = normalizarTelefonoAR('0261 15 2062258');
    expect(normalizarDestinoWhatsApp(waId)).toBe('54261152062258');
  });
});
