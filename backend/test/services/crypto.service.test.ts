import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, blindIndex } from '../../src/services/crypto.service';

describe('crypto.service', () => {
  it('descifra lo que cifró (round-trip)', () => {
    const original = '48123456';
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it('produce ciphertext distinto cada vez (IV aleatorio)', () => {
    const a = encrypt('mismo-valor');
    const b = encrypt('mismo-valor');
    expect(a).not.toBe(b);
  });

  it('decrypt devuelve "" ante un valor corrupto/inválido en vez de tirar', () => {
    expect(decrypt('esto-no-es-un-ciphertext-valido')).toBe('');
  });

  it('decrypt devuelve "" ante null/undefined', () => {
    expect(decrypt(null)).toBe('');
    expect(decrypt(undefined)).toBe('');
  });

  it('blindIndex es determinístico (mismo valor -> mismo hash)', () => {
    expect(blindIndex('48123456')).toBe(blindIndex('48123456'));
  });

  it('blindIndex ignora espacios al principio/final', () => {
    expect(blindIndex('48123456')).toBe(blindIndex('  48123456  '));
  });

  it('blindIndex distingue valores distintos', () => {
    expect(blindIndex('48123456')).not.toBe(blindIndex('48123457'));
  });
});
