import { query } from '../../config/db';
import { sendList } from './graphApi';
import { getSesion, clearSesion, setSesion } from './session.store';
import { handleCotizacion, handlePedirNuevoContenedor } from './flows/cotizacion.flow';
import { handlePago } from './flows/pago.flow';
import { handleChofer } from './flows/chofer.flow';
import { handleAsesor } from './flows/asesor.flow';
import { handleRecambio } from './flows/recambio.flow';
import { handlePedirRetiro } from './flows/pedirRetiro.flow';
import { handlePedirEntrega } from './flows/pedirEntrega.flow';
import { handleDetalleMovimientos } from './flows/movimientos.flow';
import { handleAlargarRetiro } from './flows/alargarRetiro.flow';
import { contenedoresDelCliente } from '../../services/contenedorCliente.service';
import { esAsesorDirecto, manejarAsesorDirecto } from './estados';
import type { Sesion } from './session.store';

/**
 * Submenú "Gestionar mi contenedor": unifica retiro anticipado, recambio y
 * extensión (antes eran 3 botones sueltos en el menú principal). Es un
 * mensaje de un solo paso, sin flujo/paso propio — cada opción dispara
 * directo el flow correspondiente por su seleccionId de siempre.
 */
async function enviarMenuGestionar(to: string): Promise<void> {
  await sendList(
    to,
    '🛠️ Gestionar mi contenedor',
    '¿Qué necesitás hacer con tu contenedor?',
    'Ver opciones',
    [
      { id: 'opt_pedir_retiro', title: '📥 Retiro anticipado', description: 'Se llenó antes de tiempo: que lo pasen a buscar' },
      { id: 'opt_recambio', title: '🔄 Recambio', description: 'Cambiar el contenedor lleno por uno vacío' },
      { id: 'opt_alargar_retiro', title: '⏳ Extender 5 días', description: 'Sumar 5 días más antes de que lo retiremos' },
      { id: 'opt_asesor', title: '🙋 Asesor', description: 'Hablar con una persona del equipo' },
    ],
  );
  await setSesion({ telefono: to, flujo: 'menu', paso: null, contexto: {} });
}

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

  // 2.a) Botón "Hablar con asesor" ofrecido tras 2 respuestas inválidas
  // seguidas (ver estados.ts): escala directo, sin el conteo de 3 pedidos
  // espontáneos que sí tiene pideAsesor() más abajo.
  if (!enModoHumano && esAsesorDirecto(m)) {
    return manejarAsesorDirecto(m, sesion);
  }

  if (!enModoHumano && m.tipo !== 'image' && m.tipo !== 'document' && pideAsesor(m)) {
    return handleAsesor(m, sesion);
  }

  // 3) Un comprobante (imagen/documento) siempre entra al flujo de pago,
  // incluso en modo humano: la validación de pagos no debe depender de un
  // operador. Excepción: si el cliente está a mitad de "alargar retiro"
  // esperando SU comprobante, que vaya ahí — si no, el pago de flete
  // interceptaría el comprobante del alargue.
  if ((m.tipo === 'image' || m.tipo === 'document') && sesion.flujo === 'alargar_retiro') {
    return handleAlargarRetiro(m, sesion);
  }
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
  if (sesion.flujo === 'alargar_retiro') return handleAlargarRetiro(m, sesion);

  // 5) Comandos de arranque
  if (m.seleccionId === 'opt_cotizar' || t.includes('cotiz') || t.includes('nuevo contenedor') || t.includes('pedir contenedor')) {
    return iniciarPedirContenedor(m, sesion);
  }
  if (
    m.seleccionId === 'opt_pagar' ||
    t.includes('pago') ||
    t.includes('pagar') ||
    t.includes('pagu') ||
    t.includes('comprobante')
  ) {
    return handlePago(m, { ...sesion, flujo: 'pago', paso: null });
  }
  if (m.seleccionId === 'opt_gestionar' || t.includes('gestionar')) {
    return enviarMenuGestionar(m.from);
  }
  if (m.seleccionId === 'opt_recambio' || t.includes('recambio')) {
    return handleRecambio(m, { ...sesion, flujo: 'recambio', paso: null });
  }
  if (m.seleccionId === 'opt_pedir_retiro' || t.includes('retiro') || t.includes('retirar')) {
    return handlePedirRetiro(m, { ...sesion, flujo: 'pedir_retiro', paso: null });
  }
  if (m.seleccionId === 'opt_detalle_movimientos' || t.includes('movimiento') || t.includes('resumen')) {
    return handleDetalleMovimientos(m, sesion);
  }
  if (m.seleccionId === 'opt_alargar_retiro' || t.includes('alargar') || t.includes('extender')) {
    return handleAlargarRetiro(m, { ...sesion, flujo: 'alargar_retiro', paso: null });
  }

  // 6) Fallback
  return enviarMenuPrincipal(m.from);
}

/**
 * "Cotizar" / "Pedir un contenedor" son la misma entrada (ver diagrama
 * aprobado) — el camino exacto depende de quién es el cliente:
 *  - Cuenta corriente aprobada: no paga antes, usa el circuito directo de
 *    "Pedir entrega" (sin comprobante, se confirma solo).
 *  - Ocasional que YA tiene un contenedor: ofrece reusar la última ubicación
 *    verificada en vez de arrancar de cero (handlePedirNuevoContenedor).
 *  - Resto (cliente nuevo o sin contenedor todavía): flujo completo de
 *    cotización con verificación de ubicación desde cero.
 */
async function iniciarPedirContenedor(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const [cliente] = await query<{ cuenta_corriente_estado: string }>(
    'SELECT cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [m.from],
  );
  if (cliente?.cuenta_corriente_estado === 'aprobada') {
    return handlePedirEntrega(m, { ...sesion, flujo: 'pedir_entrega', paso: null });
  }
  if ((await contenedoresDelCliente(m.from)).length > 0) {
    return handlePedirNuevoContenedor(m, { ...sesion, flujo: 'cotizacion', paso: null });
  }
  return handleCotizacion(m, { ...sesion, flujo: 'cotizacion', paso: null });
}

/**
 * Menú principal, mismo esquema de 5 ítems para todos (ver diagrama
 * aprobado) — solo cambian el saludo y qué ítems se muestran:
 *  - "Cotizar" / "Pedir un contenedor": siempre visible, un solo botón (ver
 *    iniciarPedirContenedor — el camino interno varía según el cliente).
 *  - "Gestionar mi contenedor": solo si ya tiene uno entregado.
 *  - "Enviar comprobante de pago": siempre visible.
 *  - "Resumen de cuenta": solo cuenta corriente aprobada. Si un cliente
 *    común lo pide por texto libre, handleDetalleMovimientos ya le explica
 *    que es exclusivo de cuenta corriente y ofrece asesor.
 *  - "Asesor": siempre.
 */
async function enviarMenuPrincipal(to: string): Promise<void> {
  const [cliente] = await query<{ nombre: string; cuenta_corriente_estado: string }>(
    'SELECT nombre, cuenta_corriente_estado FROM clientes WHERE telefono = $1',
    [to],
  );
  const tieneContenedor = (await contenedoresDelCliente(to)).length > 0;
  const esCuentaCorriente = cliente?.cuenta_corriente_estado === 'aprobada';

  // Cuenta corriente: menú propio, no el genérico. No "cotiza" (no paga en
  // el momento, el pedido se confirma solo y se acumula en su cuenta), así
  // que el copy no puede ser el mismo que el de un cliente que sí necesita
  // ver un precio antes de decidir — y como es una relación recurrente
  // (varios contenedores a lo largo del tiempo), se le ofrece todo lo que
  // puede necesitar sin tener que escribir texto libre para encontrarlo.
  if (esCuentaCorriente) {
    await sendList(
      to,
      `👋 ¡Hola, ${cliente.nombre}!`,
      'Soy el asistente de *MoraTrans* 🚚. Tenés *cuenta corriente activa* — ¿en qué te ayudo hoy?\n\n' +
        '_Escribí *menú* cuando quieras volver acá, y *asesor* si preferís hablar con una persona._',
      'Ver opciones',
      [
        { id: 'opt_cotizar', title: '📦 Pedir contenedor', description: 'Se confirma solo, se suma a tu cuenta corriente' },
        ...(tieneContenedor
          ? [{ id: 'opt_gestionar', title: '🛠️ Gestionar', description: 'Retiro anticipado, recambio o extensión' }]
          : []),
        { id: 'opt_detalle_movimientos', title: '📊 Resumen de cuenta', description: 'Detalle de tus entregas/retiros por Excel' },
        { id: 'opt_pagar', title: '💸 Enviar comprobante', description: 'Si querés transferir algo a cuenta ahora' },
        { id: 'opt_asesor', title: '🙋 Asesor', description: 'Hablar con una persona del equipo' },
      ],
    );
    await setSesion({ telefono: to, flujo: 'menu', paso: null, contexto: {} });
    return;
  }

  const opciones = [
    { id: 'opt_cotizar', title: '🧮 Cotizar', description: 'Pedir un contenedor — el precio depende de la zona' },
    ...(tieneContenedor
      ? [{ id: 'opt_gestionar', title: '🛠️ Gestionar', description: 'Retiro anticipado, recambio o extensión' }]
      : []),
    { id: 'opt_pagar', title: '💸 Enviar comprobante', description: 'Mandar el comprobante de un pago' },
    { id: 'opt_asesor', title: '🙋 Asesor', description: 'Hablar con una persona del equipo' },
  ];

  await sendList(
    to,
    '👋 ¡Hola!',
    'Soy el asistente de *MoraTrans* 🚚. ¿En qué te ayudo hoy?\n\n' +
      '_Escribí *menú* cuando quieras volver acá, y *asesor* si preferís hablar con una persona._',
    'Ver opciones',
    opciones,
  );

  // Sin esto, un cliente parado en el menú principal (que todavía no eligió
  // ninguna opción) no deja fila en sesiones_chat, y el cron de inactividad
  // (jobs/inactividadChat.cron.ts) no tiene nada que avisar ni cerrar: filtra
  // por `flujo IS NOT NULL`. 'menu' no matchea ningún flujo real en el paso 4
  // de enrutar(), así que la próxima respuesta se interpreta como comando
  // normal (paso 5), pero mientras tanto el cron sí puede avisar/cerrar.
  await setSesion({ telefono: to, flujo: 'menu', paso: null, contexto: {} });
}
