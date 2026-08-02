import { query } from '../../config/db';
import { sendText } from './graphApi';
import { getSesion, clearSesion } from './session.store';
import { handleCotizacion } from './flows/cotizacion.flow';
import { handlePago } from './flows/pago.flow';
import { handleChofer } from './flows/chofer.flow';

/** Mensaje normalizado, agnóstico del formato crudo de Meta. */
export interface MensajeEntrante {
  from: string; // teléfono E.164 sin '+'
  tipo: 'text' | 'interactive_list' | 'interactive_button' | 'image' | 'document' | 'otro';
  texto?: string; // texto o título del botón/lista
  seleccionId?: string; // id de la opción elegida en list/button
  mediaId?: string; // id del media (comprobante)
  mediaMime?: string;
}

/** Extrae un MensajeEntrante del objeto `message` de la Graph API. */
export function normalizar(msg: any): MensajeEntrante {
  const from = msg.from as string;
  switch (msg.type) {
    case 'text':
      return { from, tipo: 'text', texto: msg.text?.body?.trim() };
    case 'interactive': {
      const it = msg.interactive;
      if (it.type === 'list_reply')
        return { from, tipo: 'interactive_list', seleccionId: it.list_reply.id, texto: it.list_reply.title };
      if (it.type === 'button_reply')
        return { from, tipo: 'interactive_button', seleccionId: it.button_reply.id, texto: it.button_reply.title };
      return { from, tipo: 'otro' };
    }
    case 'image':
      return { from, tipo: 'image', mediaId: msg.image?.id, mediaMime: msg.image?.mime_type };
    case 'document':
      return { from, tipo: 'document', mediaId: msg.document?.id, mediaMime: msg.document?.mime_type };
    default:
      return { from, tipo: 'otro' };
  }
}

const COMANDOS_MENU = ['menu', 'menú', 'hola', 'inicio', 'start'];

/**
 * Enrutador principal. Decide el flujo según:
 *  1. Si el teléfono pertenece a un chofer -> flujo chofer.
 *  2. Si hay un flujo en curso en la sesión -> continúa ese flujo.
 *  3. Comandos / selección de menú -> arranca el flujo correspondiente.
 */
export async function enrutar(m: MensajeEntrante): Promise<void> {
  // 1) ¿Es un chofer conocido? El flujo del chofer tiene prioridad.
  const chofer = await query(
    'SELECT id FROM choferes WHERE telefono = $1 AND activo = TRUE',
    [m.from],
  );
  const sesion = await getSesion(m.from);

  if (chofer.length > 0 || sesion.flujo === 'chofer') {
    return handleChofer(m, sesion);
  }

  // 2) Un comprobante (imagen/documento) siempre entra al flujo de pago.
  if (m.tipo === 'image' || m.tipo === 'document') {
    return handlePago(m, sesion);
  }

  // 3) Flujo en curso
  if (sesion.flujo === 'cotizacion') return handleCotizacion(m, sesion);
  if (sesion.flujo === 'pago') return handlePago(m, sesion);

  // 4) Comandos de arranque / menú principal
  const t = (m.texto ?? '').toLowerCase();
  if (COMANDOS_MENU.includes(t) || m.seleccionId === 'menu_principal') {
    await clearSesion(m.from);
    return enviarMenuPrincipal(m.from);
  }
  if (m.seleccionId === 'opt_cotizar' || t.includes('cotiz')) return handleCotizacion(m, { ...sesion, flujo: 'cotizacion', paso: null });
  if (m.seleccionId === 'opt_pagar' || t.includes('pago') || t.includes('pagar')) return handlePago(m, { ...sesion, flujo: 'pago', paso: null });

  // 5) Fallback
  return enviarMenuPrincipal(m.from);
}

async function enviarMenuPrincipal(to: string): Promise<void> {
  await sendText(
    to,
    '👋 ¡Hola! Soy el asistente logístico.\n\n' +
      'Escribí una opción:\n' +
      '• *cotizar* — precio por departamento\n' +
      '• *pagar* — enviar comprobante de pago\n\n' +
      'También podés escribir *menú* en cualquier momento.',
  );
}
