import { describe, it, expect } from 'vitest';
import { validarPassword } from '../../src/services/password-policy.service';

// Estos casos se rechazan por largo o por score de zxcvbn ANTES de que la
// función llegue a consultar HaveIBeenPwned por red — no hace falta mockear
// fetch para probarlos. El caso "contraseña válida" sí pega a la red (capa
// extra, no bloqueante si falla) y queda fuera de este test unitario.
describe('validarPassword', () => {
  it('rechaza contraseñas cortas sin llegar a evaluar el score', async () => {
    const error = await validarPassword('Corta1!');
    expect(error).toMatch(/al menos 12 caracteres/);
  });

  it('rechaza contraseñas predecibles/comunes aunque sean largas', async () => {
    const error = await validarPassword('aaaaaaaaaaaa');
    expect(error).toMatch(/predecible/);
  });

  it('rechaza datos del propio usuario como contraseña', async () => {
    const error = await validarPassword('juanperez1234', ['juanperez1234', 'juan.perez@empresa.com']);
    expect(error).not.toBeNull();
  });
});
