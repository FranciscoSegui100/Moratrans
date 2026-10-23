import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendText, sendButtons, motivoErrorWa } from '../whatsapp/graphApi';
import { menuChofer } from '../whatsapp/flows/chofer.flow';
import { notificarEnvioFallido } from '../whatsapp/alertaEnvio';
import { resolverUbicacion } from '../../services/ubicaciones.service';
import { reservarParaEntrega, liberarReservaEntrega } from '../../services/contenedorReserva.service';
import { emitRecursoActualizado } from '../../config/socket';
import { avisoPagoChofer } from '../whatsapp/avisoEfectivo';
import { formatearTelefonoLegible } from '../../services/telefono.service';
import { notificarClienteChoferEnCamino } from '../whatsapp/notificacionesCliente';
import { hoyMendozaISO } from '../../services/fechas.service';
import { contenedoresDelCliente } from '../../services/contenedorCliente.service';

export const viajesRouter = Router();
viajesRouter.use(requireAuth);

/**
 * Reintenta una vez más, tras una espera corta, un envío de WhatsApp al
 * chofer — cubre el hiccup transitorio típico de la API de Meta antes de
 * darlo por fallido. Si el reintento también falla, el error se deja
 * propagar igual para que el llamador registre la alerta de envío fallido
 * (ver notificarEnvioFallido) — esto no la reemplaza, solo reduce cuántas
 * veces se llega a necesitarla.
 */
async function conReintento(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
    await fn();
  }
}

function fail(msg: string, status = 409): never {
  const err: any = new Error(msg);
  err.status = status;
  throw err;
}

/**
 * GET /api/viajes?fecha=YYYY-MM-DD&estado=programado&chofer_id=&ruta_id=
 * `ruta_id=null` (el literal, no el valor JS) filtra los viajes SIN rutear
 * todavía — es la cola de la pestaña Ruta (ver rutas.routes.ts). No filtra
 * por fecha a propósito en ese caso: un pedido de hoy tiene que poder verse
 * al armar la ruta de pasado mañana.
 */
viajesRouter.get('/', async (req: Request, res: Response) => {
  const { fecha, estado, chofer_id: choferId, ruta_id: rutaId } = req.query as Record<string, string>;
  const conds: string[] = [];
  const params: any[] = [];
  if (fecha) { params.push(fecha); conds.push(`v.fecha = $${params.length}`); }
  if (estado) { params.push(estado); conds.push(`v.estado = $${params.length}`); }
  if (choferId) { params.push(choferId); conds.push(`v.chofer_id = $${params.length}`); }
  if (rutaId === 'null') conds.push(`v.ruta_id IS NULL`);
  else if (rutaId) { params.push(rutaId); conds.push(`v.ruta_id = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(hoyMendozaISO());
  const hoyParam = `$${params.length}`;
  const rows = await query(
    `SELECT v.id, v.tipo, v.fecha, v.estado, v.zona, v.contenedor_numero, v.destino_direccion,
            v.destino_lat, v.destino_lng, v.horario_preferido, v.hora_estimada,
            v.cliente_telefono, v.notas, c.nombre AS chofer_nombre, v.chofer_id, v.patente, v.grupo_id,
            v.remito, v.importe, v.ubicacion_id, v.ubicacion_direccion, v.ruta_id, v.orden,
            v.ruta_confirmada_en, v.completada_en, v.chofer_notificado_en,
            v.es_cuenta_corriente, v.pago_id,
            -- Origen/destino final del viaje: la entrega sale del depósito
            -- (ubicacion_direccion) y llega a lo del cliente (destino_direccion);
            -- el retiro sale de lo del cliente y llega al vaciadero. No se
            -- guarda como columna aparte para no duplicar datos.
            CASE WHEN v.tipo = 'entrega' THEN v.ubicacion_direccion ELSE v.destino_direccion END AS origen_direccion,
            CASE WHEN v.tipo = 'entrega' THEN v.destino_direccion ELSE v.ubicacion_direccion END AS destino_final_direccion,
            -- Misma vista "por contrato" que GET /api/contenedores (columna
            -- estado_contrato) y dashboard.routes.ts (GET /contenedores) —
            -- expresión duplicada a propósito, mantener las tres en sync.
            CASE
              WHEN EXISTS (
                SELECT 1 FROM viajes v2
                 WHERE v2.contenedor_numero = v.contenedor_numero AND v2.tipo = 'retiro' AND v2.estado = 'en_curso'
              ) THEN 'yendo_a_vaciar'
              -- "Para retirar" es solo cuando el retiro ya está próximo/vencido
              -- (fecha <= hoy) — ver mismo comentario en contenedores.routes.ts.
              WHEN EXISTS (
                SELECT 1 FROM viajes v2
                 WHERE v2.contenedor_numero = v.contenedor_numero AND v2.tipo = 'retiro' AND v2.estado = 'programado' AND v2.fecha <= ${hoyParam}::date
              ) THEN 'para_retirar'
              WHEN ct.estado = 'entregado' AND ct.vence_en IS NOT NULL AND ct.vence_en < now() THEN 'vencido'
              WHEN ct.estado = 'entregado' THEN 'alquilado'
              ELSE ct.estado::text
            END AS contenedor_estado,
            -- Comprobantes asociados (inicial de flete + extensiones de alargue_retiro)
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', p.id,
                'tipo', p.tipo,
                'monto', p.monto,
                'estado', p.estado,
                'es_cuenta_corriente', p.es_cuenta_corriente,
                'tiene_comprobante', (p.url_comprobante IS NOT NULL),
                'titular', p.titular_transferencia,
                'creado_en', p.creado_en
              ) ORDER BY p.creado_en ASC)
              FROM pagos p
              WHERE (p.id = v.pago_id)
                 OR (p.tipo = 'alargue_retiro'
                     AND p.contenedor_numero = v.contenedor_numero
                     AND p.cliente_telefono = v.cliente_telefono
                     AND p.creado_en >= v.creado_en)
            ), '[]'::json) AS comprobantes
       FROM viajes v
       LEFT JOIN choferes c ON c.id = v.chofer_id
       LEFT JOIN contenedores ct ON ct.numero = v.contenedor_numero
       ${where}
       ORDER BY v.fecha, v.creado_en`,
    params,
  );
  res.json(rows);
});

const nuevoSchema = z.object({
  // 'recambio' no es un tipo_viaje real en la DB: crea un par 'retiro'+'entrega'
  // unido por grupo_id (ver comentario de viajes.grupo_id en schema.sql).
  tipo: z.enum(['entrega', 'retiro', 'recambio']),
  fecha: z.string(), // YYYY-MM-DD
  chofer_id: z.string().uuid().optional(),
  // entrega: el que se entrega, opcional (si no se manda, se asigna después
  // con la UI "Asignar" de la tabla de Viajes). retiro/recambio: el lleno
  // que se retira — acá SÍ es obligatorio (validado más abajo, no con
  // .optional() porque además hay que chequear contra la DB que el
  // contenedor está de verdad entregado a este cliente, ver
  // contenedorCliente.service.ts) — sin esto se podía armar un retiro de un
  // contenedor que el cliente nunca tuvo.
  contenedor_numero: z.string().optional(),
  // Solo recambio: el vacío que se deja. Si no se manda, la pata 'entrega'
  // queda sin contenedor para que el operador lo asigne después (misma UI
  // "Asignar" que ya existe en la tabla de Viajes).
  contenedor_numero_entrega: z.string().optional(),
  // Obligatorio: sin esto el viaje queda sin dueño — no dispara los avisos
  // al cliente por WhatsApp, no aparece en su ficha (ClienteDetalle) ni en
  // su cuenta corriente, un registro muerto para todo el resto del panel
  // (ver "Programar nuevo viaje" en Rutas.tsx, único caller de este POST).
  cliente_telefono: z.string().min(1, 'Falta el cliente'),
  zona: z.string().optional(),
  destino_direccion: z.string().optional(),
  notas: z.string().optional(),
  remito: z.string().optional(),
  importe: z.coerce.number().nonnegative().optional(),
  // Depósito (si tipo='entrega') o vaciadero (si tipo='retiro') de donde
  // sale/adonde llega el contenedor del lado de la empresa (ver GET /,
  // columna origen_direccion). Opcional si sólo hay una ubicación activa de
  // ese tipo: se autoselecciona más abajo.
  ubicacion_id: z.string().uuid().optional(),
  // Hora estimada que carga el operador (llegada si es entrega, retiro si es
  // retiro) — "HH:MM", independiente de horario_preferido (lo pidió el
  // cliente por WhatsApp, ver horarioPreferido.flow.ts).
  hora_estimada: z.string().optional(),
  // Franja horaria que pidió el cliente. Normalmente la carga el bot solo
  // (horarioPreferido.flow.ts), pero un viaje armado a mano desde el panel
  // (ej. entrega directa por cuenta corriente, sin pasar por el bot) también
  // puede necesitarla — mismos textos que OPCIONES_HORARIO ahí, pero es
  // texto libre acá: no hace falta importarlos para validar.
  horario_preferido: z.string().optional(),
});

/** Nombre del cliente para mostrarle al chofer en el aviso, si el viaje tiene un teléfono asociado. */
async function nombreClientePara(clienteTelefono: string | null): Promise<string | null> {
  if (!clienteTelefono) return null;
  const [c] = await query<{ nombre: string }>('SELECT nombre FROM clientes WHERE telefono = $1', [clienteTelefono]);
  return c?.nombre && c.nombre !== 'Sin nombre' ? c.nombre : null;
}

/** Número del cliente en formato legible ("0261 15-2062258"), para mostrarle al chofer. */
function telefonoLegible(clienteTelefono: string | null): string | null {
  return clienteTelefono ? formatearTelefonoLegible(clienteTelefono) : null;
}

/** "14:30:00" (formato TIME de Postgres) -> "14:30". */
function formatearHora(horaEstimada: string | null): string | null {
  return horaEstimada ? horaEstimada.slice(0, 5) : null;
}

/**
 * Medio de pago y monto del pago asociado a un viaje (viajes.pago_id, ver
 * schema.sql), para poder avisarle al chofer si cobra en efectivo contra
 * entrega, y cuánto (ver avisoPagoChofer). Se resuelve acá, a partir del
 * pago_id que YA viaja en la fila del viaje, en vez de que cada llamador
 * tenga que acordarse de pasarlo — antes cada aviso lo hacía "a mano" y la
 * mayoría de los call sites (asignar desde el panel, reasignar chofer,
 * siguiente parada de una ruta) directamente no lo pasaban, así que el aviso
 * de efectivo solo salía en el momento puntual de validar el pago desde el bot.
 *
 * `pagos.monto` solo se carga para alargues/abonos — un flete normal (la
 * mayoría de los casos) nace sin monto propio y el precio vive en
 * `pedidos.precio` (mismo criterio que ya usa GET /api/clientes), por eso el
 * COALESCE.
 */
async function medioPagoDeViaje(pagoId: string | null | undefined): Promise<{ medioPago: string | null; monto: string | null }> {
  if (!pagoId) return { medioPago: null, monto: null };
  const [p] = await query<{ medio_pago: string | null; monto: string | null }>(
    `SELECT p.medio_pago, COALESCE(p.monto, pe.precio) AS monto
       FROM pagos p LEFT JOIN pedidos pe ON pe.id = p.pedido_id
      WHERE p.id = $1`,
    [pagoId],
  );
  return { medioPago: p?.medio_pago ?? null, monto: p?.monto ?? null };
}

/**
 * Le avisa por WhatsApp al chofer que le acaban de programar un viaje desde
 * el panel — aclara si es envío (llevar) o retiro (buscar) del contenedor,
 * el cliente, el horario estimado (si se cargó) y la dirección de destino.
 */
export async function avisarChoferViaje(
  choferId: string,
  tipo: 'entrega' | 'retiro',
  contenedorNumero: string | null,
  destinoDireccion: string | null,
  clienteTelefono: string | null = null,
  horaEstimada: string | null = null,
  pagoId: string | null = null,
): Promise<void> {
  const [chofer] = await query<{ telefono: string | null; nombre: string }>(
    'SELECT telefono, nombre FROM choferes WHERE id = $1',
    [choferId],
  );
  if (!chofer?.telefono) return; // chofer sin número vinculado todavía: nada que mandar

  const titulo = tipo === 'entrega' ? '📦 Entrega de contenedor' : '📥 Retiro de contenedor';
  const destino = destinoDireccion
    ? `${destinoDireccion}\nhttps://www.google.com/maps?q=${encodeURIComponent(destinoDireccion)}`
    : 'Sin dirección registrada. Coordiná con el cliente antes de salir.';
  const cliente = await nombreClientePara(clienteTelefono);
  const telefonoCliente = telefonoLegible(clienteTelefono);
  const hora = formatearHora(horaEstimada);
  const { medioPago, monto } = await medioPagoDeViaje(pagoId);

  // Botón pegado al aviso, con el contenedor ya embebido en el id (mismo
  // esquema `cont:<estado>:<numero>` que ya maneja handleChofer para la
  // lista de "elegir contenedor") — así completa en un solo toque, sin
  // pasar por ningún menú genérico. Sin contenedor todavía (entrega/retiro
  // creado sin asignarlo) no hay a qué apuntar el botón: queda el texto
  // libre ("entregué"/"retiré") como único camino hasta que se le asigne.
  const boton = contenedorNumero
    ? { id: `cont:${tipo === 'entrega' ? 'entregado' : 'retirado'}:${contenedorNumero}`, title: tipo === 'entrega' ? '📦 Ya entregué' : '📥 Ya retiré' }
    : null;

  const cuerpo =
    `🚚 *${titulo}*\n\n` +
    (contenedorNumero ? `Contenedor: *${contenedorNumero}*\n` : '') +
    (cliente ? `Cliente: *${cliente}*\n` : '') +
    (telefonoCliente ? `📞 Tel: ${telefonoCliente}\n` : '') +
    (hora ? `Horario estimado: *${hora} hs*\n` : '') +
    `📍 Dirección:\n${destino}\n\n` +
    (boton ? 'Cuando la completes, tocá el botón de abajo.' : `Cuando la completes, escribime *${tipo === 'entrega' ? 'entregué' : 'retiré'}*.`) +
    avisoPagoChofer(medioPago, monto);

  await conReintento(async () => {
    if (boton) await sendButtons(chofer.telefono!, cuerpo, [boton]);
    else await sendText(chofer.telefono!, cuerpo);
  });
  await menuChofer(chofer.telefono, chofer.nombre);
}

/**
 * Le pide al chofer que vacíe un contenedor que acaba de retirar, como
 * parada propia de la secuencia de la ruta (ver avisarSiguienteParadaDesde)
 * — antes de ofrecerle la próxima parada. El botón `vaciado:<numero>`
 * dispara lo mismo que ya usa el menú self-service "🗑️" (ver
 * ofrecerVaciadosPendientes/aplicarVaciado en chofer.flow.ts), solo que acá
 * se empuja en el momento justo en vez de que el chofer tenga que acordarse
 * de ir a buscarlo.
 */
export async function avisarChoferVaciado(choferId: string, contenedorNumero: string): Promise<void> {
  const [chofer] = await query<{ telefono: string | null; nombre: string }>(
    'SELECT telefono, nombre FROM choferes WHERE id = $1',
    [choferId],
  );
  if (!chofer?.telefono) return; // chofer sin número vinculado todavía: nada que mandar

  await conReintento(async () => {
    await sendButtons(
      chofer.telefono!,
      `🗑️ *Vaciado de contenedor*\n\nContenedor: *${contenedorNumero}*\n\nCuando lo vacíes en el vaciadero, tocá el botón de abajo.`,
      [{ id: `vaciado:${contenedorNumero}`, title: '🗑️ Ya vacié' }],
    );
  });
  await menuChofer(chofer.telefono, chofer.nombre);
}

/**
 * Aviso específico para un recambio: a diferencia de avisarChoferViaje (que
 * solo hablaría del "retiro" del lleno), acá se le aclara al chofer que es
 * un recambio y qué contenedor vacío le corresponde dejar — y de qué
 * ubicación sale ese vacío, si ya se sabe.
 */
export async function avisarChoferRecambio(
  choferId: string,
  llenoNumero: string,
  vacioNumero: string | null,
  vacioUbicacionId: string | null,
  destinoDireccion: string | null,
  clienteTelefono: string | null = null,
  horaEstimada: string | null = null,
  pagoId: string | null = null,
): Promise<void> {
  const [chofer] = await query<{ telefono: string | null; nombre: string }>(
    'SELECT telefono, nombre FROM choferes WHERE id = $1',
    [choferId],
  );
  if (!chofer?.telefono) return;

  const { medioPago, monto } = await medioPagoDeViaje(pagoId);
  let ubicacionNombre: string | null = null;
  if (vacioUbicacionId) {
    const [u] = await query<{ nombre: string }>('SELECT nombre FROM ubicaciones WHERE id = $1', [vacioUbicacionId]);
    ubicacionNombre = u?.nombre ?? null;
  }

  const destino = destinoDireccion
    ? `${destinoDireccion}\nhttps://www.google.com/maps?q=${encodeURIComponent(destinoDireccion)}`
    : 'Sin dirección registrada. Coordiná con el cliente antes de salir.';
  const cliente = await nombreClientePara(clienteTelefono);
  const telefonoCliente = telefonoLegible(clienteTelefono);
  const hora = formatearHora(horaEstimada);

  const lineaVacio = vacioNumero
    ? `Retirás el contenedor lleno *${llenoNumero}* y dejás el vacío *${vacioNumero}*` +
      (ubicacionNombre ? ` (sale de: *${ubicacionNombre}*)` : '') + '.\n'
    : `Retirás el contenedor lleno *${llenoNumero}*. El vacío que dejás todavía no está asignado.\n`;

  // Botón de un solo toque para cerrar el recambio entero (retirar el lleno
  // + dejar el vacío), sin pasar por ningún menú genérico:
  // - Vacío ya asignado: apunta directo a `cont:retirado:<lleno>` — la misma
  //   acción de "marcar retirado" que ya dispara cascadearParejaRecambio,
  //   que a su vez completa el vacío solo si ya está 'reservado'.
  // - Vacío todavía sin asignar: no hay a qué apuntar un "retirado" directo
  //   (el bot no sabe qué contenedor va a dejar el chofer), así que el botón
  //   apunta a `recgrupo:<entregaId>` — el mismo selector de "con qué vacío
  //   completo el recambio" que ya usa ofrecerRecambioPendiente/elegirVacioRecambio.
  let entregaId: string | null = null;
  if (!vacioNumero) {
    const [entregaRow] = await query<{ id: string }>(
      `SELECT e.id FROM viajes r JOIN viajes e ON e.grupo_id = r.grupo_id AND e.tipo = 'entrega'
        WHERE r.contenedor_numero = $1 AND r.tipo = 'retiro' AND r.estado IN ('programado', 'en_curso')
        ORDER BY r.creado_en DESC LIMIT 1`,
      [llenoNumero],
    );
    entregaId = entregaRow?.id ?? null;
  }
  const boton = vacioNumero
    ? { id: `cont:retirado:${llenoNumero}`, title: '🔄 Recambio hecho' }
    : entregaId
      ? { id: `recgrupo:${entregaId}`, title: '🔄 Recambio hecho' }
      : null;

  const cuerpo =
    `🔄 *Recambio de contenedor*\n\n${lineaVacio}` +
    (cliente ? `Cliente: *${cliente}*\n` : '') +
    (telefonoCliente ? `📞 Tel: ${telefonoCliente}\n` : '') +
    (hora ? `Horario estimado: *${hora} hs*\n` : '') +
    `📍 Dirección:\n${destino}\n\n` +
    (boton ? 'Cuando lo completes, tocá el botón de abajo.' : 'Cuando lo completes, escribime *retiré*.') +
    avisoPagoChofer(medioPago, monto);

  await conReintento(async () => {
    if (boton) await sendButtons(chofer.telefono!, cuerpo, [boton]);
    else await sendText(chofer.telefono!, cuerpo);
  });
  await menuChofer(chofer.telefono, chofer.nombre);
}

/**
 * Al confirmar una ruta no se avisan todas sus paradas de un saque (ver
 * POST /api/rutas/:id/confirmar) — solo la primera. Esta función se llama
 * cada vez que el chofer termina una parada (marca "ya entregué"/"ya
 * retiré", ver chofer.flow.ts) y, si la parada recién cerrada era la última
 * pendiente de su `orden` (un recambio ocupa dos filas con el mismo orden:
 * hay que esperar las dos), le avisa recién ahí la parada siguiente de la
 * MISMA ruta. Si `viajeCompletadoId` no pertenece a una ruta armada (viaje
 * suelto asignado directo, o un retiro espontáneo sin ruta) no hace nada.
 *
 * Devuelve `true` si había una parada siguiente y se la avisó (el aviso ya
 * trae su propio botón de "completar" pegado, ver avisarChoferViaje/Recambio)
 * — el llamador usa esto para NO mandar además los avisos de pendientes
 * (vaciados/recambio) sueltos y evitar duplicarlos al cerrar una parada.
 */
export async function avisarSiguienteParadaRuta(viajeCompletadoId: string): Promise<boolean> {
  const [actual] = await query<{ ruta_id: string | null; orden: number | null }>(
    `SELECT ruta_id, orden FROM viajes WHERE id = $1`,
    [viajeCompletadoId],
  );
  if (!actual?.ruta_id || actual.orden == null) return false;

  const [pendienteEnMismoOrden] = await query<{ id: string }>(
    `SELECT id FROM viajes
      WHERE ruta_id = $1 AND orden = $2 AND completada_en IS NULL AND estado IN ('programado', 'en_curso')
      LIMIT 1`,
    [actual.ruta_id, actual.orden],
  );
  if (pendienteEnMismoOrden) return false; // recambio: falta que termine la otra mitad de la visita

  return avisarSiguienteParadaDesde(actual.ruta_id, actual.orden);
}

/**
 * Núcleo de avisarSiguienteParadaRuta, reutilizable desde una posición
 * (`rutaId`, `ordenActual`) en vez de un viaje puntual — hace falta para
 * seguir la secuencia después de un VACIADO (no es una fila de `viajes`, no
 * tiene id de viaje del que partir). Antes de pasar a la próxima parada de
 * tipo viaje, chequea si hay una parada de vaciado sin resolver con un
 * `orden` menor (o sea, antes en la secuencia): si la hay, se le avisa esa
 * primero — antes esta función solo miraba la tabla `viajes`, así que un
 * vaciado insertado automáticamente entre un retiro y la entrega siguiente
 * quedaba invisible para el chofer por WhatsApp (seguía viendo la próxima
 * parada de la ruta directo, sin que nadie le pidiera vaciar primero).
 */
export async function avisarSiguienteParadaDesde(rutaId: string, ordenActual: number): Promise<boolean> {
  const [siguienteVaciado] = await query<{ id: string; orden: number; contenedor_numero: string }>(
    `SELECT rv.id, rv.orden, rv.contenedor_numero
       FROM ruta_vaciados rv
       JOIN contenedores c ON c.numero = rv.contenedor_numero
      WHERE rv.ruta_id = $1 AND rv.orden > $2 AND c.estado = 'retirado'
      ORDER BY rv.orden ASC LIMIT 1`,
    [rutaId, ordenActual],
  );

  const siguientes = await query<{
    id: string; tipo: 'entrega' | 'retiro'; contenedor_numero: string | null; destino_direccion: string | null;
    ubicacion_id: string | null; grupo_id: string | null; chofer_id: string | null; orden: number;
    cliente_telefono: string | null; hora_estimada: string | null; pago_id: string | null;
  }>(
    `SELECT id, tipo, contenedor_numero, destino_direccion, ubicacion_id, grupo_id, chofer_id, orden, cliente_telefono, hora_estimada, pago_id
       FROM viajes
      WHERE ruta_id = $1 AND orden > $2 AND ruta_confirmada_en IS NOT NULL
        AND estado IN ('programado', 'en_curso') AND completada_en IS NULL
      ORDER BY orden ASC`,
    [rutaId, ordenActual],
  );

  // El vaciado va antes si su `orden` es menor que la próxima parada de tipo
  // viaje (o si no queda ninguna parada de viaje pendiente) — misma regla
  // que ya usa el panel para calcular qué contenedores ofrecer en cada
  // parada (ver disponibilidad.service.ts).
  if (siguienteVaciado && (siguientes.length === 0 || siguienteVaciado.orden < siguientes[0].orden)) {
    const [ruta] = await query<{ chofer_id: string | null }>('SELECT chofer_id FROM rutas WHERE id = $1', [rutaId]);
    if (!ruta?.chofer_id) return false;
    try {
      await avisarChoferVaciado(ruta.chofer_id, siguienteVaciado.contenedor_numero);
      await query(`UPDATE ruta_vaciados SET chofer_notificado_en = now() WHERE id = $1`, [siguienteVaciado.id]);
    } catch (e: any) {
      const motivo = motivoErrorWa(e);
      console.error('Error avisando vaciado pendiente:', motivo);
      notificarEnvioFallido(siguienteVaciado.id, `chofer de la ruta ${rutaId}`, 'aviso de vaciado', motivo).catch(
        (e2) => console.error('Error registrando alerta de envío fallido:', e2),
      );
    }
    return true;
  }

  if (siguientes.length === 0) return false;
  const proximoOrden = siguientes[0].orden;
  const visita = siguientes.filter((v) => v.orden === proximoOrden);
  const choferId = visita[0].chofer_id;
  if (!choferId) return false;

  const entrega = visita.find((v) => v.tipo === 'entrega');
  const retiro = visita.find((v) => v.tipo === 'retiro');
  try {
    if (entrega?.grupo_id && retiro) {
      await avisarChoferRecambio(
        choferId, retiro.contenedor_numero!, entrega.contenedor_numero, entrega.ubicacion_id,
        entrega.destino_direccion, entrega.cliente_telefono, entrega.hora_estimada, retiro.pago_id ?? entrega.pago_id,
      );
    } else {
      const v = entrega ?? retiro!;
      await avisarChoferViaje(choferId, v.tipo, v.contenedor_numero, v.destino_direccion, v.cliente_telefono, v.hora_estimada, v.pago_id);
    }

    await query(
      `UPDATE viajes SET chofer_notificado_en = now() WHERE id = ANY($1)`,
      [visita.map((v) => v.id)],
    );

    // Notificación automática al cliente: chofer en camino
    const viajeCliente = entrega ?? retiro;
    if (viajeCliente?.cliente_telefono) {
      const [choferInfo] = await query<{ nombre: string; patente: string | null }>(
        'SELECT nombre, patente FROM choferes WHERE id = $1',
        [choferId],
      );
      notificarClienteChoferEnCamino({
        clienteTelefono: viajeCliente.cliente_telefono,
        tipo: viajeCliente.tipo,
        destinoDireccion: viajeCliente.destino_direccion,
        choferNombre: choferInfo?.nombre ?? null,
        patente: choferInfo?.patente ?? null,
        contenedorNumero: viajeCliente.contenedor_numero,
      }).catch((e) => console.error('Error notificando chofer en camino al cliente:', e));
    }
  } catch (e: any) {
    const motivo = motivoErrorWa(e);
    console.error('Error avisando la siguiente parada de la ruta:', motivo);
    notificarEnvioFallido(visita[0].id, `chofer de la ruta ${rutaId}`, 'aviso de siguiente parada', motivo).catch(
      (e2) => console.error('Error registrando alerta de envío fallido:', e2),
    );
  }
  // Había parada siguiente (se haya podido enviar o no): el menú suelto no
  // corresponde — si falló el envío ya se levantó una alerta para el operador.
  return true;
}

/** POST /api/viajes — programar un viaje, o un recambio (par retiro+entrega) (admin/operador). */
viajesRouter.post('/', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const v = parsed.data;

  // Retiro/recambio sin esta validación se podía armar para cualquier
  // contenedor "entregado" que hubiera, sin importar a quién — mismo
  // criterio que ya usa el bot (pedirRetiro.flow.ts, recambio.flow.ts) vía
  // contenedoresDelCliente(), acá reforzado también del lado servidor (no
  // solo limitando las opciones del selector en el panel).
  if (v.tipo === 'retiro' || v.tipo === 'recambio') {
    if (!v.contenedor_numero) {
      return res.status(400).json({ error: 'Para un retiro o recambio hace falta elegir qué contenedor se retira.' });
    }
    const propios = await contenedoresDelCliente(v.cliente_telefono);
    if (!propios.some((c) => c.numero === v.contenedor_numero)) {
      return res.status(409).json({
        error: `El contenedor ${v.contenedor_numero} no figura entregado a este cliente — elegí uno de los que tiene, o revisá el teléfono.`,
      });
    }
  }

  // Depósito para una entrega, vaciadero para un retiro. Si no se especificó
  // uno y hay más de una ubicación activa de ese tipo, hace falta que el
  // operador elija — a diferencia de los flujos del bot, acá sí se puede
  // pedir explícitamente (ver ubicaciones.service.ts).
  const tipoUbicacion = v.tipo === 'entrega' ? 'deposito' : 'vaciadero';
  let ubicacion: { id: string; direccion: string } | null = null;
  if (v.ubicacion_id) {
    ubicacion = await resolverUbicacion(tipoUbicacion, v.ubicacion_id);
    if (!ubicacion) return res.status(400).json({ error: 'Ubicación inválida para este tipo de viaje.' });
  } else {
    const activas = await query<{ id: string; direccion: string }>(
      'SELECT id, direccion FROM ubicaciones WHERE tipo = $1 AND activo = TRUE ORDER BY creado_en',
      [tipoUbicacion],
    );
    if (activas.length === 1) ubicacion = activas[0];
    else if (activas.length > 1) {
      return res.status(400).json({
        error: `Elegí ${tipoUbicacion === 'deposito' ? 'un depósito' : 'un vaciadero'}: hay más de uno cargado.`,
      });
    }
    // 0 activas: se deja sin ubicación (todavía no se cargó ninguna en /ubicaciones).
  }

  try {
    const resultado = await withTx(async (c) => {
      // reservarParaEntrega (backend/src/services/contenedorReserva.service.ts):
      // a lo sumo una reserva activa por contenedor, se usa tanto para una
      // entrega suelta como para la pata "entrega" de un recambio.
      const actualizadoPor = `operador:${req.user!.id}`;

      // Foto de la patente del chofer al momento de crear el viaje (ver
      // comentario de viajes.patente en schema.sql).
      let patente: string | null = null;
      if (v.chofer_id) {
        const { rows: choferRows } = await c.query<{ patente: string | null }>(
          'SELECT patente FROM choferes WHERE id = $1',
          [v.chofer_id],
        );
        patente = choferRows[0]?.patente ?? null;
      }

      if (v.tipo === 'recambio') {
        if (v.contenedor_numero_entrega) {
          await reservarParaEntrega(c, v.contenedor_numero_entrega, v.fecha, actualizadoPor);
        }
        const grupoId = randomUUID();
        // `ubicacion` (resuelta arriba como vaciadero, porque tipo !== 'entrega')
        // es el destino del lleno que se retira. El depósito del vacío que se
        // deja se resuelve aparte y sin exigir elección — no hay un segundo
        // selector para esto en el panel, mismo criterio "silencioso" que usa
        // el bot en recambio.flow.ts.
        const deposito = await resolverUbicacion('deposito');
        const { rows: retiroRows } = await c.query(
          `INSERT INTO viajes (tipo, fecha, hora_estimada, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, remito, importe, grupo_id, ubicacion_id, ubicacion_direccion, horario_preferido)
           VALUES ('retiro',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [v.fecha, v.hora_estimada || null, v.chofer_id ?? null, v.contenedor_numero ?? null, v.cliente_telefono ?? null, v.zona ?? null,
           v.destino_direccion ?? null, v.notas ?? null, patente, v.remito ?? null, v.importe ?? null, grupoId,
           ubicacion?.id ?? null, ubicacion?.direccion ?? null, v.horario_preferido ?? null],
        );
        const { rows: entregaRows } = await c.query(
          `INSERT INTO viajes (tipo, fecha, hora_estimada, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, grupo_id, ubicacion_id, ubicacion_direccion, horario_preferido)
           VALUES ('entrega',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [v.fecha, v.hora_estimada || null, v.chofer_id ?? null, v.contenedor_numero_entrega ?? null, v.cliente_telefono ?? null, v.zona ?? null,
           v.destino_direccion ?? null, v.notas ?? null, patente, grupoId, deposito?.id ?? null, deposito?.direccion ?? null, v.horario_preferido ?? null],
        );
        return { principal: retiroRows[0], secundario: entregaRows[0] };
      }

      if (v.tipo === 'entrega' && v.contenedor_numero) {
        await reservarParaEntrega(c, v.contenedor_numero, v.fecha, actualizadoPor);
      }

      const { rows } = await c.query(
        `INSERT INTO viajes (tipo, fecha, hora_estimada, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, notas, patente, remito, importe, ubicacion_id, ubicacion_direccion, horario_preferido)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [v.tipo, v.fecha, v.hora_estimada || null, v.chofer_id ?? null, v.contenedor_numero ?? null,
         v.cliente_telefono ?? null, v.zona ?? null, v.destino_direccion ?? null, v.notas ?? null, patente,
         v.remito ?? null, v.importe ?? null, ubicacion?.id ?? null, ubicacion?.direccion ?? null, v.horario_preferido ?? null],
      );
      return { principal: rows[0], secundario: null as any };
    });

    // Si es un recambio sin el lleno todavía asignado, no hay nada útil que
    // avisarle al chofer todavía — el aviso sale solo cuando se le asigna el
    // contenedor lleno desde la tabla de Viajes (ver PATCH /:id más abajo).
    const contenedorListoParaAvisar = v.tipo !== 'recambio' || !!resultado.principal.contenedor_numero;
    if (v.chofer_id && contenedorListoParaAvisar) {
      const avisoRecambioOChofer = v.tipo === 'recambio'
        ? avisarChoferRecambio(
            v.chofer_id,
            resultado.principal.contenedor_numero!,
            resultado.secundario?.contenedor_numero ?? null,
            resultado.secundario?.ubicacion_id ?? null,
            v.destino_direccion ?? null,
            v.cliente_telefono ?? null,
            v.hora_estimada ?? null,
            resultado.principal.pago_id ?? null,
          )
        : avisarChoferViaje(
            v.chofer_id,
            resultado.principal.tipo,
            resultado.principal.contenedor_numero ?? null,
            v.destino_direccion ?? null,
            v.cliente_telefono ?? null,
            v.hora_estimada ?? null,
            resultado.principal.pago_id ?? null,
          );
      avisoRecambioOChofer.catch((e) => {
        const motivo = motivoErrorWa(e);
        console.error('Error avisando al chofer el viaje programado:', motivo);
        notificarEnvioFallido(resultado.principal.id, `chofer del viaje ${resultado.principal.id}`, 'aviso de viaje programado', motivo).catch(
          (e2) => console.error('Error registrando alerta de envío fallido:', e2),
        );
      });
    }

    res.status(201).json(resultado.principal);
  } catch (error: any) {
    if (error.status === 409) {
      res.status(409).json({ error: error.message });
    } else if (error.code === '23503') { // Foreign key violation
      res.status(400).json({ error: 'El contenedor o chofer especificado no existe.' });
    } else {
      console.error('Error al insertar viaje:', error);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
});

const patchSchema = z.object({
  estado: z.enum(['programado', 'en_curso', 'completado', 'cancelado']).optional(),
  fecha: z.string().optional(),
  // Hora estimada de llegada (entrega) o de retiro (retiro) que carga el
  // operador — "HH:MM" o null para borrarla.
  hora_estimada: z.string().nullable().optional(),
  chofer_id: z.string().uuid().nullable().optional(),
  // Sobre todo para completar la fila 'entrega' de un recambio (ver
  // recambio.flow.ts): se crea sin contenedor porque el bot no elige cuál
  // vacío sale — el operador lo asigna acá, como cualquier entrega nueva.
  contenedor_numero: z.string().min(1).nullable().optional(),
  remito: z.string().nullable().optional(),
  importe: z.coerce.number().nonnegative().nullable().optional(),
  ubicacion_id: z.string().uuid().nullable().optional(),
  // Corrección de departamento/dirección por un asesor (ej. el cliente se
  // equivocó de departamento al pedirlo) — ver guarda más abajo y el
  // comentario de "cambiaZona".
  zona: z.string().min(1).nullable().optional(),
  destino_direccion: z.string().min(1).nullable().optional(),
});

/** PATCH /api/viajes/:id — cambiar estado, reasignar chofer o contenedor (admin/operador). */
viajesRouter.patch('/:id', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  // '' (input de hora vaciado) no es un TIME válido para Postgres — se
  // interpreta como "borrar la hora estimada".
  if (parsed.data.hora_estimada === '') parsed.data.hora_estimada = null;
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, val] of Object.entries(parsed.data)) {
    params.push(val); sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
  // Reasignar chofer también actualiza la foto de patente del viaje (ver
  // comentario de viajes.patente en schema.sql).
  if ('chofer_id' in parsed.data) {
    const nuevoChoferId = parsed.data.chofer_id;
    const patente = nuevoChoferId
      ? (await query<{ patente: string | null }>('SELECT patente FROM choferes WHERE id = $1', [nuevoChoferId]))[0]?.patente ?? null
      : null;
    params.push(patente); sets.push(`patente = $${params.length}`);
  }
  // Reasignar la ubicación (depósito/vaciadero) también recalcula la foto de
  // su dirección — mismo patrón que chofer_id/patente arriba.
  if ('ubicacion_id' in parsed.data) {
    const nuevoUbicacionId = parsed.data.ubicacion_id;
    let direccion: string | null = null;
    if (nuevoUbicacionId) {
      const [viajeActual] = await query<{ tipo: 'entrega' | 'retiro' }>(
        'SELECT tipo FROM viajes WHERE id = $1',
        [req.params.id],
      );
      if (!viajeActual) return res.status(404).json({ error: 'Viaje inexistente' });
      const tipoUbicacion = viajeActual.tipo === 'entrega' ? 'deposito' : 'vaciadero';
      const ubicacion = await resolverUbicacion(tipoUbicacion, nuevoUbicacionId);
      if (!ubicacion) return res.status(400).json({ error: 'Ubicación inválida para este tipo de viaje.' });
      direccion = ubicacion.direccion;
    }
    params.push(direccion); sets.push(`ubicacion_direccion = $${params.length}`);
  }
  params.push(req.params.id);
  try {
    // Asignar contenedor a una entrega (sobre todo el vacío de un recambio,
    // ver comentario de contenedor_numero en patchSchema) tiene que reservarlo
    // de verdad — misma validación atómica que un viaje nuevo (POST /) o que
    // confirmar una ruta: si no, el contenedor sigue figurando 'disponible' y
    // el bot puede volver a ofrecérselo a otro cliente (o el pago validarlo
    // solo) mientras "ya estaba asignado" en el panel.
    const row = await withTx(async (c) => {
      const { rows: viajeRows } = await c.query<{
        tipo: string; fecha: string; ruta_id: string | null; orden: number | null;
        completada_en: string | null; ruta_confirmada_en: string | null; estado: string;
        chofer_id: string | null; contenedor_numero: string | null; zona: string | null; importe: string | null;
      }>(
        'SELECT tipo, fecha, ruta_id, orden, completada_en, ruta_confirmada_en, estado, chofer_id, contenedor_numero, zona, importe FROM viajes WHERE id = $1 FOR UPDATE',
        [req.params.id],
      );
      if (!viajeRows[0]) return null;
      const viajeActual = viajeRows[0];

      // Reasignar chofer o contenedor es tan delicado como cancelar: cambiarle
      // a mitad de camino quién la maneja, o qué contenedor es, sobre una
      // parada que el chofer ya completó o a la que ya está yendo ahora mismo,
      // deja el viaje y la ruta con datos que no coinciden con la realidad. Si
      // el valor estaba vacío (recambio sin contenedor asignado todavía,
      // viaje sin chofer en la bolsa) completarlo no cuenta como reasignar.
      const reasignaChofer = 'chofer_id' in parsed.data && viajeActual.chofer_id != null && parsed.data.chofer_id !== viajeActual.chofer_id;
      const reasignaContenedor =
        'contenedor_numero' in parsed.data && viajeActual.contenedor_numero != null && parsed.data.contenedor_numero !== viajeActual.contenedor_numero;
      // Un asesor corrigiendo el departamento (ej. el cliente se equivocó al
      // pedirlo) — mismo riesgo que reasignar: no tiene sentido tocarlo sobre
      // una parada ya entregada/retirada o a la que el chofer ya está yendo.
      // A propósito NO toca `importe`: si ya estaba pagado, el precio pagado
      // queda congelado tal cual — ver `tarifaZonaNueva` en la respuesta,
      // que el panel usa para avisar la diferencia y que un humano la
      // resuelva (no se mueve plata sola).
      const cambiaZona = 'zona' in parsed.data && parsed.data.zona != null && parsed.data.zona !== viajeActual.zona;
      if (parsed.data.estado === 'cancelado' || reasignaChofer || reasignaContenedor || cambiaZona) {
        const accion = parsed.data.estado === 'cancelado' ? 'cancelar' : cambiaZona ? 'cambiar el departamento de' : 'reasignar';
        if (viajeActual.completada_en != null) {
          return fail(`No se puede ${accion}: el chofer ya completó esta parada.`, 409);
        }
        if (viajeActual.ruta_id != null && viajeActual.orden != null && viajeActual.ruta_confirmada_en != null) {
          const { rows: anterioresPendientes } = await c.query<{ id: string }>(
            `SELECT id FROM viajes
              WHERE ruta_id = $1 AND orden < $2 AND completada_en IS NULL
              LIMIT 1`,
            [viajeActual.ruta_id, viajeActual.orden],
          );
          if (anterioresPendientes.length === 0) {
            return fail(`No se puede ${accion}: el chofer ya está yendo a entregar o retirar este pedido.`, 409);
          }
        }
      }

      if ('contenedor_numero' in parsed.data && parsed.data.contenedor_numero) {
        if (viajeActual.tipo === 'entrega') {
          await reservarParaEntrega(c, parsed.data.contenedor_numero, viajeActual.fecha, `operador:${req.user!.id}`, {
            excluirViajeId: req.params.id,
          });
        }
      }
      // Si cambia el departamento, no se inventa un precio (ver comentario de
      // `cambiaZona` arriba): solo se valida que el departamento nuevo tenga
      // tarifa activa (mismo departamento que ofrece el bot), y se devuelve
      // su precio para que el panel compare contra lo ya pagado.
      let tarifaZonaNueva: string | null = null;
      if (cambiaZona) {
        const { rows: tarifaRows } = await c.query<{ precio: string }>(
          'SELECT precio FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
          [parsed.data.zona],
        );
        if (!tarifaRows[0]) return fail(`"${parsed.data.zona}" no es un departamento con tarifa activa.`, 400);
        tarifaZonaNueva = tarifaRows[0].precio;
      }
      const { rows } = await c.query(
        `UPDATE viajes SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      return rows[0] ? { ...rows[0], tarifaZonaNueva } : null;
    });
    if (!row) return res.status(404).json({ error: 'Viaje inexistente' });

    res.json(row);

    // Reasignar chofer no pasa por broadcastCambios de la pestaña
    // Contenedores (esa ruta es '/viajes/...', solo avisa 'viajes') — sin
    // esto, la columna "Chofer asignado" de Contenedores quedaba
    // desactualizada hasta hacer F5.
    const cambioChofer = 'chofer_id' in parsed.data;
    // Ya no solo el vacío de una entrega: un recambio también puede crearse
    // sin el lleno que va a retirar, así que esto dispara igual cuando se le
    // completa el contenedor a un 'retiro'.
    const cambioContenedorAsignado = 'contenedor_numero' in parsed.data && !!row.contenedor_numero;
    if (cambioChofer || cambioContenedorAsignado) emitRecursoActualizado('contenedores');

    // Si se tocó el chofer (asignación nueva o reasignación) o se acaba de
    // completar el contenedor de un viaje (el vacío de una entrega o el
    // lleno de un retiro, típicamente los de un recambio, ver comentario de
    // contenedor_numero en patchSchema), y ya hay alguien asignado, le
    // mandamos el mismo aviso que recibiría si el viaje se hubiera creado
    // así desde el principio — antes esto solo pasaba en POST /api/viajes,
    // así que reasignar desde la tabla de Viajes no le avisaba nada al
    // chofer nuevo.
    if (row.chofer_id && (cambioChofer || cambioContenedorAsignado)) {
      (async () => {
        if (row.grupo_id) {
          const [retiro] = await query<{ contenedor_numero: string | null }>(
            `SELECT contenedor_numero FROM viajes WHERE grupo_id = $1 AND tipo = 'retiro' LIMIT 1`,
            [row.grupo_id],
          );
          const [entrega] = await query<{ contenedor_numero: string | null; ubicacion_id: string | null }>(
            `SELECT contenedor_numero, ubicacion_id FROM viajes WHERE grupo_id = $1 AND tipo = 'entrega' LIMIT 1`,
            [row.grupo_id],
          );
          if (retiro?.contenedor_numero) {
            await avisarChoferRecambio(
              row.chofer_id, retiro.contenedor_numero, entrega?.contenedor_numero ?? null, entrega?.ubicacion_id ?? null,
              row.destino_direccion, row.cliente_telefono, row.hora_estimada, row.pago_id ?? null,
            );
          }
        } else {
          await avisarChoferViaje(row.chofer_id, row.tipo, row.contenedor_numero, row.destino_direccion, row.cliente_telefono, row.hora_estimada, row.pago_id ?? null);
        }
      })().catch((e) => {
        const motivo = motivoErrorWa(e);
        console.error('Error avisando al chofer la asignación:', motivo);
        notificarEnvioFallido(row.id, `chofer del viaje ${row.id}`, 'aviso de asignación', motivo).catch(
          (e2) => console.error('Error registrando alerta de envío fallido:', e2),
        );
      });
    }
  } catch (error: any) {
    if (error.status) {
      res.status(error.status).json({ error: error.message });
    } else if (error.code === '23503') { // Foreign key violation
      res.status(400).json({ error: 'El chofer especificado no existe.' });
    } else {
      console.error('Error al actualizar viaje:', error);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
});

/**
 * DELETE /api/viajes/:id — eliminar un viaje (solo admin, idealmente cuando
 * está completado o cancelado). No está cableado a ningún botón del panel
 * hoy (soporte manual vía API) — igual se envuelve en transacción y libera
 * la reserva del contenedor si borra una entrega que todavía lo tenía
 * reservado, para no dejarlo colgado como 'reservado' sin ningún viaje real
 * detrás.
 */
viajesRouter.delete('/:id', requireRol('admin'), async (req: Request, res: Response) => {
  try {
    const row = await withTx(async (c) => {
      const { rows } = await c.query<{ id: string; tipo: string; contenedor_numero: string | null }>(
        'SELECT id, tipo, contenedor_numero FROM viajes WHERE id = $1 FOR UPDATE',
        [req.params.id],
      );
      const viaje = rows[0];
      if (!viaje) return null;
      if (viaje.tipo === 'entrega' && viaje.contenedor_numero) {
        await liberarReservaEntrega(c, viaje.contenedor_numero, `admin:${req.user!.id}`);
      }
      await c.query('DELETE FROM viajes WHERE id = $1', [viaje.id]);
      return viaje;
    });
    if (!row) return res.status(404).json({ error: 'Viaje inexistente' });
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('contenedores');
    res.json({ success: true });
  } catch (e: any) {
    console.error('Error al eliminar viaje:', e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});
