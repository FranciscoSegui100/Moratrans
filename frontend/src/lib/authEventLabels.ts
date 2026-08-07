/** Etiquetas legibles por tipo de evento de auditoría de autenticación — usado en la página Auditoría. */
export const authEventoLabel: Record<string, string> = {
  login_exitoso:              'Login exitoso',
  login_fallido:              'Login fallido',
  mfa_fallido:                'Código MFA incorrecto',
  bloqueo_temporal:           'Cuenta bloqueada (intentos fallidos)',
  logout:                     'Cierre de sesión',
  password_reset_solicitado:  'Pidió restablecer contraseña',
  password_reset_exitoso:     'Restableció su contraseña',
  dispositivo_nuevo:          'Login desde dispositivo nuevo',
  sesion_revocada:            'Sesión revocada',
  refresh_reutilizado:        'Refresh token reutilizado (posible robo)',
  mfa_activado:               'Activó MFA',
  mfa_desactivado:            'Desactivó MFA',
};
