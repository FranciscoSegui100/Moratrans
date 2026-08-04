import { query } from '../../config/db';
import { sendList } from './graphApi';
import { getSesion, clearSesion } from './session.store';
import { handleCotizacion } from './flows/cotizacion.flow';
import { handlePago } from './flows/pago.flow';
import { handleChofer } from './flows/chofer.flow';
import { handleAsesor } from './flows/asesor.flow';

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

const COMANDOS_MENU = ['menu', 'menú', 'hola', 'inicio', 'start', 'volver'];

/** ¿El mensaje pide explícitamente hablar con un asesor? */
function pideAsesor(m: MensajeEntrante): boolean {
  if (m.seleccionId === 'opt_asesor') return true;
  const t = (m.texto ?? '').toLowerCase();
  return t.includes('asesor') || t.includes('humano') || t.includes('operador');
}

/**
 * Enrutador principal. Decide el flujo según:
 *  1. Si el teléfono pertenece a un chofer -> flujo chofer.
 *  2. Comandos globales (menú / asesor) -> funcionan en cualquier momento,
 *     incluso en medio de otro flujo.
 *  3. Un comprobante (imagen/documento) -> siempre al flujo de pago.
 *  4. Si hay un flujo en curso en la sesión -> continúa ese flujo.
 *  5. Comandos de arranque -> inicia el flujo correspondiente.
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

  // 2) Comandos globales: funcionan siempre, sin importar en qué flujo esté.
  const t = (m.texto ?? '').toLowerCase();
  if (m.tipo === 'text' || m.tipo === 'interactive_list' || m.tipo === 'interactive_button') {
    if (COMANDOS_MENU.includes(t) || m.seleccionId === 'menu_principal') {
      await clearSesion(m.from);
      return enviarMenuPrincipal(m.from);
    }
    if (pideAsesor(m)) return handleAsesor(m, sesion);
  }

  // 3) Un comprobante (imagen/documento) siempre entra al flujo de pago.
  if (m.tipo === 'image' || m.tipo === 'document') {
    return handlePago(m, sesion);
  }

  // 4) Flujo en curso
  if (sesion.flujo === 'cotizacion') return handleCotizacion(m, sesion);
  if (sesion.flujo === 'pago') return handlePago(m, sesion);

  // 5) Comandos de arranque
  if (m.seleccionId === 'opt_cotizar' || t.includes('cotiz')) return handleCotizacion(m, { ...sesion, flujo: 'cotizacion', paso: null });
  if (
    m.seleccionId === 'opt_pagar' ||
    t.includes('pago') ||
    t.includes('pagar') ||
    t.includes('pagu') ||
    t.includes('comprobante')
  ) {
    return handlePago(m, { ...sesion, flujo: 'pago', paso: null });
  }

  // 6) Fallback
  return enviarMenuPrincipal(m.from);
}

async function enviarMenuPrincipal(to: string): Promise<void> {
  await sendList(
    to,
    '👋 ¡Hola!',
    'Soy el asistente de *MoraTrans* 🚚. ¿En qué te ayudo hoy?\n\n' +
    '_Escribí *menú* cuando quieras volver acá, y *asesor* si preferís hablar con una persona._',
    'Ver opciones',
    [
      { id: 'opt_cotizar', title: '🧮 Cotizar', description: 'Precio del flete por departamento' },
      { id: 'opt_pagar', title: '💸 Ya pagué', description: 'Quiero enviar mi comprobante de pago' },
      { id: 'opt_asesor', title: '🙋 Asesor', description: 'Hablar con una persona del equipo' },
    ],
  );
}
