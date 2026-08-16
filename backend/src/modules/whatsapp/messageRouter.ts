import { query } from '../../config/db';
import { sendList } from './graphApi';
import { getSesion, clearSesion } from './session.store';
import { handleCotizacion } from './flows/cotizacion.flow';
import { handlePago } from './flows/pago.flow';
import { handleChofer } from './flows/chofer.flow';
import { handleAsesor } from './flows/asesor.flow';
import { handleRecambio } from './flows/recambio.flow';
import { handlePedirRetiro } from './flows/pedirRetiro.flow';
import { handlePedirEntrega } from './flows/pedirEntrega.flow';

/** Mensaje normalizado, agnóstico del formato crudo de Meta. */
export interface MensajeEntrante {
  from: string; // teléfono E.164 sin '+'
  tipo: 'text' | 'interactive_list' | 'interactive_button' | 'image' | 'document' | 'location' | 'otro';
  texto?: string; // texto o título del botón/lista
  seleccionId?: string; // id de la opción elegida en list/button
  mediaId?: string; // id del media (comprobante)
  mediaMime?: string;
  lat?: number; // ubicación GPS compartida por el cliente
  lng?: number;
  ubicacionNombre?: string; // 'name' que WhatsApp adjunta a la ubicación, si el usuario le puso una
  ubicacionDireccion?: string; // 'address' que WhatsApp adjunta a la ubicación, si el usuario le puso una
  nombrePerfil?: string; // nombre que el cliente tiene puesto en su WhatsApp (viene gratis en cada mensaje)
}

/** Extrae un MensajeEntrante del objeto `message` de la Graph API. */
export function normalizar(msg: any, nombrePerfil?: string): MensajeEntrante {
  const from = msg.from as string;
  switch (msg.type) {
    case 'text':
      return { from, tipo: 'text', texto: msg.text?.body?.trim(), nombrePerfil };
    case 'interactive': {
      const it = msg.interactive;
      if (it.type === 'list_reply')
        return { from, tipo: 'interactive_list', seleccionId: it.list_reply.id, texto: it.list_reply.title, nombrePerfil };
      if (it.type === 'button_reply')
        return { from, tipo: 'interactive_button', seleccionId: it.button_reply.id, texto: it.button_reply.title, nombrePerfil };
      return { from, tipo: 'otro', nombrePerfil };
    }
    case 'image':
      return { from, tipo: 'image', mediaId: msg.image?.id, mediaMime: msg.image?.mime_type, nombrePerfil };
    case 'document':
      return { from, tipo: 'document', mediaId: msg.document?.id, mediaMime: msg.document?.mime_type, nombrePerfil };
    case 'location':
      return {
        from,
        tipo: 'location',
        lat: msg.location?.latitude,
        lng: msg.location?.longitude,
        ubicacionNombre: msg.location?.name,
        ubicacionDireccion: msg.location?.address,
        nombrePerfil,
      };
    default:
      return { from, tipo: 'otro', nombrePerfil };
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
  }

  // 2.b) Modo humano: un operador tomó esta conversación a mano desde el panel.
  // El bot se calla (no reprocesa "asesor" ni sigue flujos) hasta que el cliente
  // escriba "menú" (arriba) o el operador marque la alerta como resuelta.
  const enModoHumano = !!sesion.contexto?.modoHumano;

  if (!enModoHumano && m.tipo !== 'image' && m.tipo !== 'document' && pideAsesor(m)) {
    return handleAsesor(m, sesion);
  }

  // 3) Un comprobante (imagen/documento) siempre entra al flujo de pago,
  // incluso en modo humano: la validación de pagos no debe depender de un operador.
  if (m.tipo === 'image' || m.tipo === 'document') {
    return handlePago(m, sesion);
  }

  if (enModoHumano) return; // el mensaje ya quedó logueado en mensajes_chat

  // 4) Flujo en curso
  if (sesion.flujo === 'cotizacion') return handleCotizacion(m, sesion);
  if (sesion.flujo === 'pago') return handlePago(m, sesion);
  if (sesion.flujo === 'recambio') return handleRecambio(m, sesion);
  if (sesion.flujo === 'pedir_retiro') return handlePedirRetiro(m, sesion);
  if (sesion.flujo === 'pedir_entrega') return handlePedirEntrega(m, sesion);

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
  if (m.seleccionId === 'opt_recambio' || t.includes('recambio')) {
    return handleRecambio(m, { ...sesion, flujo: 'recambio', paso: null });
  }
  if (m.seleccionId === 'opt_pedir_retiro' || t.includes('retiro') || t.includes('retirar')) {
    return handlePedirRetiro(m, { ...sesion, flujo: 'pedir_retiro', paso: null });
  }
  if (m.seleccionId === 'opt_pedir_entrega' || t.includes('entrega')) {
    return handlePedirEntrega(m, { ...sesion, flujo: 'pedir_entrega', paso: null });
  }

  // 6) Fallback
  return enviarMenuPrincipal(m.from);
}

/**
 * Identifica al cliente por su teléfono (ver clientes.service.ts) y, si
 * tiene cuenta corriente aprobada, lo saluda por su nombre y le suma la
 * opción "Pedir entrega" (pedir un contenedor sin pagar antes) — eso es
 * exclusivo de cuenta corriente, un cliente ocasional no la ve; retiro y
 * recambio siguen disponibles para cualquiera.
 */
async function enviarMenuPrincipal(to: string): Promise<void> {
  const [cliente] = await query<{ nombre: string; cuenta_corriente_estado: string }>(
    'SELECT nombre, cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [to],
  );
  const esCuentaCorriente = cliente?.cuenta_corriente_estado === 'aprobada';
  const saludo = esCuentaCorriente ? `👋 ¡Hola, ${cliente.nombre}!` : '👋 ¡Hola!';
  const bajada = esCuentaCorriente
    ? 'Soy el asistente de *MoraTrans* 🚚. Tenés *cuenta corriente activa* — ¿en qué te ayudo hoy?\n\n'
    : 'Soy el asistente de *MoraTrans* 🚚. ¿En qué te ayudo hoy?\n\n';

  const opciones = [
    { id: 'opt_cotizar', title: '🧮 Cotizar', description: 'Precio del flete por departamento' },
    { id: 'opt_pagar', title: '💸 Ya pagué', description: 'Quiero enviar mi comprobante de pago' },
    ...(esCuentaCorriente
      ? [{ id: 'opt_pedir_entrega', title: '📦 Pedir entrega', description: 'Cuenta corriente: pedir un contenedor sin pagar antes' }]
      : []),
    { id: 'opt_pedir_retiro', title: '📥 Pedir retiro', description: 'Se llenó antes de tiempo: que lo pasen a buscar' },
    { id: 'opt_recambio', title: '🔄 Pedir recambio', description: 'Cambiar el contenedor lleno por uno vacío' },
    { id: 'opt_asesor', title: '🙋 Asesor', description: 'Hablar con una persona del equipo' },
  ];

  await sendList(
    to,
    saludo,
    bajada + '_Escribí *menú* cuando quieras volver acá, y *asesor* si preferís hablar con una persona._',
    'Ver opciones',
    opciones,
  );
}
