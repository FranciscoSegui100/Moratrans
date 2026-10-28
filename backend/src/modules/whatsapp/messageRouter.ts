import { query } from '../../config/db';
import { env } from '../../config/env';
import { sendList, sendText, sendButtons, motivoErrorWa } from './graphApi';
import { getSesion, clearSesion, setSesion } from './session.store';
import { botEstaActivo } from '../../services/botConfig.service';
import { DIAS_ALQUILER_ANTES_RETIRO, MENSAJE_BOT_DESACTIVADO } from '../../config/bot.config';
import { handleCotizacion, handlePedirNuevoContenedor } from './flows/cotizacion.flow';
import { handlePago, pedidosAbiertos, opcionesMetodoPago, ofrecerPedidoPendiente, avisarAdjuntoSinContexto } from './flows/pago.flow';
import { handleChofer } from './flows/chofer.flow';
import { handleAsesor, escalarAAsesor } from './flows/asesor.flow';
import { handleRecambio } from './flows/recambio.flow';
import { handlePedirRetiro } from './flows/pedirRetiro.flow';
import { handlePedirEntrega } from './flows/pedirEntrega.flow';
import { iniciarPedidoCatalogo, handlePedidoCatalogo } from './flows/pedidoCatalogo.flow';
import { handleDetalleMovimientos } from './flows/movimientos.flow';
import { handleAlargarRetiro } from './flows/alargarRetiro.flow';
import { contenedoresDelCliente } from '../../services/contenedorCliente.service';
import { esAsesorDirecto, manejarAsesorDirecto, manejarRespuestaInvalida } from './estados';
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
      { id: 'opt_ver_vencimiento', title: '📅 Ver vencimiento', description: 'Cuándo vence el alquiler de tu contenedor' },
      { id: 'opt_asesor', title: '🙋 Asesor', description: 'Hablar con una persona del equipo' },
    ],
  );
  await setSesion({ telefono: to, flujo: 'menu', paso: null, contexto: {} });
}

/**
 * "📅 Ver vencimiento": respuesta de un solo paso, sin flujo/paso propio
 * (mismo patrón que handleDetalleMovimientos) — para que el cliente pueda
 * consultar la fecha por su cuenta en vez de depender solo del aviso
 * proactivo del cron (que además puede fallar si el cliente no escribió
 * nada en las últimas 24hs, ver alertas.cron.ts).
 */
async function handleVerVencimiento(to: string): Promise<void> {
  const contenedores = await contenedoresDelCliente(to);
  if (contenedores.length === 0) {
    await sendText(to, 'No encontramos ningún contenedor activo a tu nombre. Si te parece que es un error, escribí *asesor*.');
    return;
  }
  const hoy = new Date();
  const hoyStr = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
  const lineas = contenedores.map((c) => {
    if (!c.vence_en) return `📦 *${c.numero}* — todavía no tiene fecha de vencimiento cargada.`;
    const [anio, mes, dia] = c.vence_en.split('-');
    const fecha = `${dia}/${mes}/${anio}`;
    const vencido = c.vence_en < hoyStr;
    return `📦 *${c.numero}* — ${vencido ? 'venció el' : 'vence el'} *${fecha}*`;
  });
  await sendText(to, `📅 *Vencimiento de tu contenedor:*\n\n${lineas.join('\n')}`);
}

/**
 * Rubros del catálogo de WhatsApp, en el mismo orden en que figuran ahí.
 * `opt_serv_contenedores` es el único que el bot resuelve solo (va al flujo
 * de cotización de siempre); el resto escala a un asesor nombrando el rubro.
 */
const OTROS_SERVICIOS = [
  { id: 'opt_serv_maquinaria_vial', title: '🚜 Maquinaria vial' },
  { id: 'opt_serv_maquinaria_agricola', title: '🌾 Maquinaria agrícola' },
  { id: 'opt_serv_safe_box', title: '🔒 Safe box' },
  { id: 'opt_serv_camiones', title: '🚛 Camiones' },
  { id: 'opt_serv_contenedores', title: '📦 Contenedores' },
  { id: 'opt_serv_aridos', title: '🪨 Áridos' },
];

/** Submenú "Otros servicios": mismo esquema de un solo paso que enviarMenuGestionar. */
async function enviarMenuOtrosServicios(to: string): Promise<void> {
  await sendList(
    to,
    '📨 Otros servicios',
    '¿Sobre qué servicio querés consultar?',
    'Ver opciones',
    OTROS_SERVICIOS,
  );
  await setSesion({ telefono: to, flujo: 'menu', paso: null, contexto: {} });
}

const IDS_CONTENEDOR_CATALOGO = env.WA_CATALOGO_IDS_CONTENEDOR.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean);

/**
 * ¿El carrito del catálogo trae únicamente contenedores? Meta manda solo el
 * retailer_id de cada producto (sin nombre), así que se compara contra los
 * ids configurados. Un carrito mixto no cuenta: lo que no es contenedor lo
 * tiene que cotizar un asesor, y partir el pedido en dos confundiría más.
 */
function esPedidoDeContenedor(m: MensajeEntrante): boolean {
  const items = m.orderItems ?? [];
  return items.length > 0 && items.every((it) => IDS_CONTENEDOR_CATALOGO.includes(String(it.retailerId ?? '').trim().toLowerCase()));
}

/** Mensaje normalizado, agnóstico del formato crudo de Meta. */
export interface MensajeEntrante {
  from: string; // teléfono E.164 sin '+'
  tipo: 'text' | 'interactive_list' | 'interactive_button' | 'image' | 'document' | 'location' | 'order' | 'audio' | 'otro';
  texto?: string; // texto o título del botón/lista
  seleccionId?: string; // id de la opción elegida en list/button
  mediaId?: string; // id del media (comprobante)
  mediaMime?: string;
  lat?: number; // ubicación GPS compartida por el cliente
  lng?: number;
  ubicacionNombre?: string; // 'name' que WhatsApp adjunta a la ubicación, si el usuario le puso una
  ubicacionDireccion?: string; // 'address' que WhatsApp adjunta a la ubicación, si el usuario le puso una
  nombrePerfil?: string; // nombre que el cliente tiene puesto en su WhatsApp (viene gratis en cada mensaje)
  orderItems?: { retailerId: string; cantidad: number; precio?: number; nombre?: string }[]; // productos del carrito del catálogo
  catalogId?: string; // catálogo de origen del pedido, para resolver nombres de producto
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
    case 'audio':
      return { from, tipo: 'audio', mediaId: msg.audio?.id, mediaMime: msg.audio?.mime_type ?? 'audio/ogg', nombrePerfil };
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
    case 'order': {
      const items = (msg.order?.product_items ?? []).map((it: any) => ({
        retailerId: it.product_retailer_id,
        cantidad: it.quantity,
        precio: it.item_price,
      }));
      return {
        from,
        tipo: 'order',
        orderItems: items,
        catalogId: msg.order?.catalog_id,
        texto: msg.order?.text?.trim(),
        nombrePerfil,
      };
    }
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
 *  1. Si el teléfono pertenece a un chofer -> flujo chofer (exento del punto 1.b).
 *  1.b. Bot desactivado a mano desde el panel -> mensaje fijo, corta acá.
 *  2. Comandos globales (menú / asesor) -> funcionan en cualquier momento,
 *     incluso en medio de otro flujo.
 *  3. Un comprobante (imagen/documento) -> al flujo de pago si el cliente
 *     entró por "Enviar comprobante"; si no, se le pide que use ese botón.
 *  4. Si hay un flujo en curso en la sesión -> continúa ese flujo.
 *  5. Comandos de arranque -> inicia el flujo correspondiente.
 */
export async function enrutar(m: MensajeEntrante): Promise<void> {
  // 1) ¿Es un chofer conocido? El flujo del chofer tiene prioridad.
  // Independientes entre sí (tablas distintas, ninguna depende del resultado
  // de la otra) — en paralelo para no pagar dos round-trips a la DB en CADA
  // mensaje entrante, el camino más caliente de todo el bot.
  const [chofer, sesion] = await Promise.all([
    query('SELECT id FROM choferes WHERE telefono = $1 AND activo = TRUE', [m.from]),
    getSesion(m.from),
  ]);

  if (chofer.length > 0 || sesion.flujo === 'chofer') {
    return handleChofer(m, sesion);
  }

  // 1.b) Interruptor manual "Desactivar bot" (Dashboard): pausa la atención
  // automática a CUALQUIER cliente, sin tocar sesión ni flujo — se ignora
  // todo lo demás y siempre se responde el mismo aviso. No afecta a
  // choferes (ya se filtraron arriba).
  if (!(await botEstaActivo())) {
    return sendText(m.from, MENSAJE_BOT_DESACTIVADO);
  }

  // 2.b) Modo humano: un asesor tiene esta conversación. El bot se calla (no
  // reprocesa "menú" ni "asesor" ni sigue flujos) y solo vuelve cuando el
  // operador resuelve la alerta o libera la charla desde el panel — el
  // cliente no puede reactivarlo escribiendo "menú".
  const enModoHumano = !!sesion.contexto?.modoHumano;

  // 2) Comandos globales: funcionan siempre, sin importar en qué flujo esté
  // (salvo en modo humano, ver arriba).
  const t = (m.texto ?? '').toLowerCase();
  if (!enModoHumano && (m.tipo === 'text' || m.tipo === 'interactive_list' || m.tipo === 'interactive_button')) {
    if (COMANDOS_MENU.includes(t) || m.seleccionId === 'menu_principal') {
      await clearSesion(m.from);
      return enviarMenuPrincipal(m.from);
    }
  }

  // 2.a) Botón "Hablar con asesor" ofrecido tras 2 respuestas inválidas
  // seguidas (ver estados.ts): escala directo, sin el conteo de 3 pedidos
  // espontáneos que sí tiene pideAsesor() más abajo.
  if (!enModoHumano && esAsesorDirecto(m)) {
    return manejarAsesorDirecto(m, sesion);
  }

  // Respuestas a encuesta de satisfacción de cliente post-servicio
  if (m.seleccionId && m.seleccionId.startsWith('encuesta_')) {
    const estrellas = m.seleccionId === 'encuesta_5' ? '⭐⭐⭐⭐⭐' : m.seleccionId === 'encuesta_3' ? '⭐⭐⭐' : '⭐';
    try {
      await sendText(
        m.from,
        `¡Muchísimas gracias por tu calificación (${estrellas})! 🙌 Valoramos mucho que elijas a Moratrans. Si necesitás algo más, acá estamos.`,
      );
    } catch (err: any) {
      console.error('Error enviando agradecimiento de encuesta:', motivoErrorWa(err));
    }
    return;
  }

  // "Otros servicios": muestra los rubros del catálogo. A diferencia de
  // "Hablar con asesor" (pideAsesor, abajo), que primero ofrece self-service
  // y recién escala tras un par de pedidos (ver handleAsesor), al elegir un
  // rubro no hay nada que el bot pueda resolver solo — el precio y las
  // condiciones los define un asesor, así que se escala directo, ya con el
  // rubro en la alerta. La excepción es "Contenedores", que es el alquiler
  // de siempre y sigue por el flujo de cotización.
  if (!enModoHumano && m.seleccionId === 'opt_otros_servicios') {
    return enviarMenuOtrosServicios(m.from);
  }
  const servicio = OTROS_SERVICIOS.find((s) => s.id === m.seleccionId);
  if (!enModoHumano && servicio && servicio.id !== 'opt_serv_contenedores') {
    const rubro = servicio.title.replace(/^\S+\s/, ''); // sin el emoji
    return escalarAAsesor(m.from, sesion, `${m.from} consultó por "${rubro}" (Otros servicios)`);
  }

  // Pedido armado en el catálogo de WhatsApp (carrito): no hay precio ni
  // condiciones que el bot pueda resolver solo, así que junta primero
  // nombre, dirección, descripción y medio de pago (ver
  // pedidoCatalogo.flow.ts) antes de escalar al asesor con todo el detalle.
  // Excepción: un pedido de contenedor sí lo resuelve el bot, así que entra
  // directo al flujo de cotización, igual que si hubiera tocado "Cotizar".
  if (!enModoHumano && m.tipo === 'order') {
    if (esPedidoDeContenedor(m)) return iniciarPedirContenedor(m, sesion);
    return iniciarPedidoCatalogo(m, sesion);
  }

  if (!enModoHumano && m.tipo !== 'image' && m.tipo !== 'document' && pideAsesor(m)) {
    return handleAsesor(m, sesion);
  }

  // 3) Un comprobante (imagen/documento) siempre entra al flujo de pago,
  // incluso en modo humano: la validación de pagos no debe depender de un
  // operador. Excepciones: si el cliente está a mitad de "alargar retiro" o
  // de mandar el comprobante de un pedido de catálogo que el asesor ya
  // cotizó (ver pedidoCatalogo.flow.ts), que vayan a su propio flujo — si
  // no, el pago de flete interceptaría esos comprobantes.
  if ((m.tipo === 'image' || m.tipo === 'document') && sesion.flujo === 'alargar_retiro') {
    return handleAlargarRetiro(m, sesion);
  }
  if ((m.tipo === 'image' || m.tipo === 'document') && sesion.flujo === 'pedido_catalogo' && sesion.paso === 'esperando_comprobante_catalogo') {
    return handlePedidoCatalogo(m, sesion);
  }
  // Solo se toma como pago si el cliente entró por "Enviar comprobante" (la
  // sesión ya está en el flujo de pago). Una foto suelta en cualquier otro
  // momento recibe un aviso para que use el botón (ver avisarAdjuntoSinContexto).
  if (m.tipo === 'image' || m.tipo === 'document') {
    if (sesion.flujo === 'pago') return handlePago(m, sesion);
    return avisarAdjuntoSinContexto(m, sesion);
  }

  if (enModoHumano) return; // el mensaje ya quedó logueado en mensajes_chat

  // El botón "Enviar comprobante" (menú o aviso de foto sin contexto) arranca
  // el pago aunque haya otro flujo a medias — si no, el flujo en curso de
  // abajo se lo tragaba como respuesta inválida.
  if (m.seleccionId === 'opt_pagar') {
    return handlePago(m, { ...sesion, flujo: 'pago', paso: null, contexto: {} });
  }

  // 4) Flujo en curso
  if (sesion.flujo === 'cotizacion') return handleCotizacion(m, sesion);
  if (sesion.flujo === 'pago') return handlePago(m, sesion);
  if (sesion.flujo === 'recambio') return handleRecambio(m, sesion);
  if (sesion.flujo === 'pedir_retiro') return handlePedirRetiro(m, sesion);
  if (sesion.flujo === 'pedir_entrega') return handlePedirEntrega(m, sesion);
  if (sesion.flujo === 'alargar_retiro') return handleAlargarRetiro(m, sesion);
  if (sesion.flujo === 'pedido_catalogo') return handlePedidoCatalogo(m, sesion);
  if (sesion.flujo === 'pedido_pendiente') return manejarPedidoPendiente(m, sesion);

  // 5) Comandos de arranque
  if (m.seleccionId === 'opt_cotizar' || m.seleccionId === 'opt_serv_contenedores' || t.includes('cotiz') || t.includes('nuevo contenedor') || t.includes('pedir contenedor')) {
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
  if (m.seleccionId === 'opt_ver_vencimiento' || t.includes('vencimiento') || t.includes('vence')) {
    return handleVerVencimiento(m.from);
  }

  // 6) Fallback
  return enviarMenuPrincipal(m.from);
}

/**
 * "Cotizar" / "Pedir un contenedor" son la misma entrada (ver diagrama
 * aprobado) — el camino exacto depende de quién es el cliente:
 *  - Cuenta corriente aprobada: no paga antes, usa el circuito directo de
 *    "Pedir entrega" (sin comprobante, se confirma solo) — no aplica el
 *    bloqueo de "pagá el anterior primero" de abajo, ahí no hay comprobante
 *    que esperar.
 *  - Resto: si ya tiene un pedido cotizado/confirmado sin pagar, no se lo
 *    bloquea sin salida — se le ofrece pagar ese o cancelarlo y arrancar uno
 *    nuevo (ver manejarPedidoPendiente). Antes esto cortaba la conversación
 *    de punta a punta: un pedido viejo que el cliente ya no quería pagar
 *    dejaba sin forma de pedir otra cosa hasta mandar un comprobante.
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

  // Independientes entre sí (tablas distintas) — se piden las dos en paralelo
  // aunque la segunda quede sin usar si ya hay un pendiente, total la
  // prioridad (pendiente > contenedor propio > cliente nuevo) se decide igual
  // más abajo, solo que sin pagar un round-trip extra en el caso común.
  const [[pendiente], contenedoresPropios] = await Promise.all([
    pedidosAbiertos(m.from),
    contenedoresDelCliente(m.from),
  ]);
  if (pendiente) {
    await ofrecerPedidoPendiente(m.from, pendiente, 'cotizacion');
    return;
  }

  if (contenedoresPropios.length > 0) {
    return handlePedirNuevoContenedor(m, { ...sesion, flujo: 'cotizacion', paso: null });
  }
  return handleCotizacion(m, { ...sesion, flujo: 'cotizacion', paso: null });
}

/**
 * Respuesta a "Pagar ese" / "Cancelar y pedir otro" (ver iniciarPedirContenedor).
 * Cancelar solo cambia el estado del pedido viejo a 'cancelado' — no toca
 * pagos ni contenedores, porque un pedido 'cotizado'/'confirmado' sin pago
 * validado nunca llegó a reservar nada — y relanza iniciarPedirContenedor,
 * que ahora sigue de largo porque pedidosAbiertos() ya no lo va a encontrar.
 */
async function manejarPedidoPendiente(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  if (m.seleccionId === 'pedido_pendiente_pagar') {
    // No se delega a handlePago con paso null: esa función solo sabe arrancar
    // desde un mensaje de texto libre (m.tipo === 'text'); con la respuesta
    // de un botón caía al mensaje genérico de "mandá la imagen o PDF" en vez
    // de preguntar el medio de pago.
    await setSesion({ ...sesion, flujo: 'pago', paso: 'elegir_metodo_pago', contexto: {} });
    await sendButtons(m.from, '💳 ¿Cómo vas a pagar?', await opcionesMetodoPago(m.from));
    return;
  }
  if (m.seleccionId === 'pedido_pendiente_cancelar') {
    const pedidoId = sesion.contexto?.pedidoId as string | undefined;
    if (pedidoId) await query(`UPDATE pedidos SET estado = 'cancelado' WHERE id = $1`, [pedidoId]);
    await sendText(m.from, '👍 Cancelamos ese pedido.');
    const sesionLimpia = { ...sesion, flujo: null, paso: null, contexto: {} };
    // Vuelve al flujo del que vino (ver ofrecerPedidoPendiente) — si no hay
    // ninguno guardado (sesiones viejas de antes de este cambio), cae al
    // comportamiento de siempre: pedir un contenedor nuevo.
    if (sesion.contexto?.origenPedidoPendiente === 'recambio') return handleRecambio(m, sesionLimpia);
    return iniciarPedirContenedor(m, sesionLimpia);
  }
  await manejarRespuestaInvalida(m, 'Elegí "💸 Pagar ese" o "❌ Cancelar y pedir otro".');
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
  const saludo = cliente?.nombre && cliente.nombre !== 'Sin nombre' ? `👋 ¡Hola, ${cliente.nombre.split(' ')[0]}!` : '👋 ¡Hola!';
  const beneficios = `📦 Alquiler por ${DIAS_ALQUILER_ANTES_RETIRO} días\n🚛 Retiro y entrega incluida\n📍 Servicio confiable y puntual`;

  if (esCuentaCorriente) {
    await sendList(
      to,
      saludo,
      'Soy el asistente virtual de *MoraTrans* 🚚 — más de 30 años de experiencia en transporte y logística de contenedores.\n\n' +
        `${beneficios}\n\n` +
        'Tenés *cuenta corriente activa* — ¿en qué te ayudo hoy?\n\n' +
        '_Escribí *menú* cuando quieras volver acá, y *asesor* si preferís hablar con una persona._',
      'Ver opciones',
      [
        { id: 'opt_cotizar', title: '📦 Pedir contenedor', description: 'El pedido se confirma solo y se suma a tu cuenta corriente' },
        ...(tieneContenedor
          ? [{ id: 'opt_gestionar', title: '🛠️ Gestionar contenedor', description: 'Retiro anticipado, cambio de contenedor o extensión del plazo' }]
          : []),
        { id: 'opt_detalle_movimientos', title: '📊 Resumen de cuenta', description: 'Descargá el detalle de tus entregas y retiros en Excel' },
        { id: 'opt_pagar', title: '💸 Enviar comprobante', description: 'Si querés transferir algo a tu cuenta corriente ahora' },
        { id: 'opt_otros_servicios', title: '📨 Otros servicios', description: 'Maquinaria, safe box, camiones, áridos y más' },
        { id: 'opt_asesor', title: '🙋 Hablar con asesor', description: 'Te comunicamos con una persona del equipo de MoraTrans' },
      ],
    );
    await setSesion({ telefono: to, flujo: 'menu', paso: null, contexto: {} });
    return;
  }

  const opciones = [
    { id: 'opt_cotizar', title: '🧮 Cotizar contenedor', description: 'Pedido nuevo — el precio varía según la zona de entrega' },
    ...(tieneContenedor
      ? [{ id: 'opt_gestionar', title: '🛠️ Gestionar contenedor', description: 'Retiro anticipado, cambio de contenedor o extensión del plazo' }]
      : []),
    { id: 'opt_pagar', title: '💸 Enviar comprobante', description: 'Mandá la foto o PDF de tu transferencia para que la validemos' },
    { id: 'opt_otros_servicios', title: '📨 Otros servicios', description: 'Maquinaria, safe box, camiones, áridos y más' },
    { id: 'opt_asesor', title: '🙋 Hablar con asesor', description: 'Te comunicamos con una persona del equipo de MoraTrans' },
  ];

  await sendList(
    to,
    saludo,
    'Soy el asistente virtual de *MoraTrans* 🚚 — más de 30 años de experiencia en transporte y logística de contenedores.\n\n' +
      `${beneficios}\n\n` +
      '¿En qué te puedo ayudar hoy?\n\n' +
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
