import { Resend } from 'resend';
import { env } from '../config/env';

const resend = new Resend(env.RESEND_API_KEY);

/**
 * Envoltorio fino sobre Resend: nunca tira si el envío falla (loguea y
 * devuelve false) para no tumbar el flujo principal (alta de usuario, login)
 * solo porque el proveedor de email esté caído.
 */
async function enviar(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html });
    if (error) {
      console.error('Resend rechazó el envío:', error);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Error enviando email:', e);
    return false;
  }
}

function layout(titulo: string, cuerpoHtml: string) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1f2937;">
      <div style="background: #1e293b; color: #fff; padding: 16px 24px; border-radius: 8px 8px 0 0; font-weight: bold;">
        Moratrans — Panel de gestión logística
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <h2 style="margin-top: 0; font-size: 18px;">${titulo}</h2>
        ${cuerpoHtml}
        <p style="color: #9ca3af; font-size: 12px; margin-top: 32px;">
          Si no reconocés esta actividad, contactá a un administrador del panel.
        </p>
      </div>
    </div>
  `;
}

function boton(href: string, texto: string) {
  return `<a href="${href}" style="display:inline-block; background:#1e293b; color:#fff; text-decoration:none; padding:10px 20px; border-radius:6px; margin: 16px 0;">${texto}</a>`;
}

export function linkInvitacion(token: string): string {
  return `${env.APP_URL}/aceptar-invitacion?token=${token}`;
}

export async function enviarInvitacion(to: string, nombre: string, token: string) {
  const link = linkInvitacion(token);
  return enviar(
    to,
    'Te invitaron al panel de Moratrans',
    layout('Bienvenido/a', `
      <p>Hola ${nombre},</p>
      <p>Se creó una cuenta para vos en el panel de gestión logística de Moratrans. Elegí tu contraseña para activarla:</p>
      ${boton(link, 'Activar mi cuenta')}
      <p style="font-size: 13px; color: #6b7280;">Este link vence en 30 minutos. Si no esperabas esta invitación, ignorá el correo.</p>
    `),
  );
}

export async function enviarResetPassword(to: string, token: string) {
  const link = `${env.APP_URL}/reset-password?token=${token}`;
  return enviar(
    to,
    'Restablecer tu contraseña — Moratrans',
    layout('Restablecer contraseña', `
      <p>Pediste restablecer tu contraseña del panel de Moratrans.</p>
      ${boton(link, 'Elegir nueva contraseña')}
      <p style="font-size: 13px; color: #6b7280;">Este link vence en 30 minutos. Si no fuiste vos, ignorá este correo — tu contraseña actual sigue funcionando.</p>
    `),
  );
}

export async function enviarPasswordCambiada(to: string) {
  return enviar(
    to,
    'Tu contraseña cambió — Moratrans',
    layout('Contraseña actualizada', `
      <p>Tu contraseña del panel de Moratrans se cambió correctamente. Todas tus sesiones activas se cerraron por seguridad.</p>
      <p>Si no fuiste vos, avisá a un administrador de inmediato.</p>
    `),
  );
}

/** Código de verificación en dos pasos (método email): tanto para activarlo como para cada login. */
export async function enviarCodigoMfa(to: string, codigo: string) {
  return enviar(
    to,
    `${codigo} — tu código de verificación de Moratrans`,
    layout('Tu código de verificación', `
      <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; text-align: center; margin: 24px 0;">${codigo}</p>
      <p style="font-size: 13px; color: #6b7280;">Vence en 10 minutos. Si no lo pediste vos, ignorá este correo.</p>
    `),
  );
}

export async function enviarAlertaDispositivoNuevo(to: string, detalle: { ip: string | null; userAgent: string | null; fecha: Date }) {
  return enviar(
    to,
    'Nuevo inicio de sesión — Moratrans',
    layout('Detectamos un inicio de sesión desde un dispositivo nuevo', `
      <p>Se inició sesión en tu cuenta del panel de Moratrans desde un dispositivo que no reconocíamos:</p>
      <ul style="font-size: 14px; color: #374151;">
        <li><strong>Fecha:</strong> ${detalle.fecha.toLocaleString('es-AR')}</li>
        <li><strong>IP:</strong> ${detalle.ip ?? 'desconocida'}</li>
        <li><strong>Dispositivo:</strong> ${detalle.userAgent ?? 'desconocido'}</li>
      </ul>
      <p>Si fuiste vos, no hace falta que hagas nada. Si no reconocés esta actividad, restablecé tu contraseña ahora:</p>
      ${boton(`${env.APP_URL}/forgot-password?email=${encodeURIComponent(to)}`, 'No fui yo — cambiar contraseña')}
    `),
  );
}
