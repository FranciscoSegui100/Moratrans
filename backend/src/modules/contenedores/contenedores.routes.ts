import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { finalizarRetiro } from '../../services/retiro.service';
import { hoyMendozaISO } from '../../services/fechas.service';
import { buscarRetiroActivo } from '../../services/retiroActivo.service';
import { reservarParaEntrega } from '../../services/contenedorReserva.service';
import { resolverUbicacion } from '../../services/ubicaciones.service';
import { diaHabilDesde, formatearFechaCorta } from '../../services/diasHabiles.service';
import { encrypt, encryptBuffer } from '../../services/crypto.service';
import { subirArchivo } from '../../services/storage.service';
import { sendText, motivoErrorWa } from '../whatsapp/graphApi';
import { notificarEnvioFallido } from '../whatsapp/alertaEnvio';
import { datosBancarios } from '../whatsapp/flows/pago.flow';
import { emitRecursoActualizado } from '../../config/socket';
import { DIAS_ALARGUE, PORCENTAJE_ALARGUE } from '../../config/bot.config';

export const contenedoresRouter = Router();
contenedoresRouter.use(requireAuth);

interface ContenedorEntregado {
  numero: string;
  estado: string;
  vence_en: Date | null;
  cliente_telefono: string;
  cuenta_corriente_estado: string;
  zona: string | null;
  destino_direccion: string | null;
  destino_lat: number | null;
  destino_lng: number | null;
  cliente_existe: boolean;
}

/**
 * Contenedor + su cliente/dirección actual (de la última entrega no
 * cancelada) + su estado de cuenta corriente — base común de los 3 flujos
 * manuales de abajo (retiro anticipado, alargue, recambio). `null` si el
 * contenedor no existe o no está 'entregado' a nadie ahora mismo.
 */
async function obtenerContenedorEntregado(numero: string): Promise<ContenedorEntregado | null> {
  const [row] = await query<ContenedorEntregado>(
    `SELECT c.numero, c.estado, c.vence_en, ultima.cliente_telefono, cl.cuenta_corriente_estado,
            ultima.zona, ultima.destino_direccion, ultima.destino_lat, ultima.destino_lng,
            (cl.id IS NOT NULL) AS cliente_existe
       FROM contenedores c
       CROSS JOIN LATERAL (
         SELECT v.cliente_telefono, v.zona, v.destino_direccion, v.destino_lat, v.destino_lng
           FROM viajes v
          WHERE v.contenedor_numero = c.numero AND v.tipo = 'entrega' AND v.estado <> 'cancelado'
          ORDER BY v.creado_en DESC LIMIT 1
       ) ultima
       LEFT JOIN clientes cl ON cl.telefono = ultima.cliente_telefono
      WHERE c.numero = $1 AND c.estado = 'entregado'`,
    [numero],
  );
  return row ?? null;
}

/**
 * Los 3 flujos manuales de abajo valen para cualquier contenedor entregado
 * (pedido por el bot o cargado a mano), pero el cliente tiene que existir en
 * Clientes — sin eso la plata no queda asociada a nadie (no aparece en su
 * ficha ni en su cuenta corriente); `codigo: 'cliente_inexistente'` le dice
 * al panel que lo mande a crearlo. Devuelve true si cortó la request.
 */
function rechazarSiNoGestionable(cont: ContenedorEntregado, res: Response): boolean {
  if (!cont.cliente_existe) {
    res.status(409).json({
      error: 'El cliente de este contenedor todavía no está cargado en Clientes. Crealo primero.',
      codigo: 'cliente_inexistente',
      telefono: cont.cliente_telefono,
    });
    return true;
  }
  return false;
}

/** "Fecha" (YYYY-MM-DD) de vence_en en hora Mendoza — mismo criterio que jobs/alertas.cron.ts. */
function fechaMendoza(fecha: Date): string {
  return new Date(fecha.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function fail(msg: string, status = 409): never {
  const err: any = new Error(msg);
  err.status = status;
  throw err;
}

/**
 * Sube y cifra un comprobante de transferencia — mismo criterio que uno que
 * llega por WhatsApp (ver pago.flow.ts) o que se carga a mano desde la ficha
 * del cliente (ver clientes.routes.ts POST /:telefono/viaje-manual).
 */
async function subirComprobanteManual(base64: string, contentType: string | undefined, prefijo: string): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > 8 * 1024 * 1024) fail('El comprobante no puede pesar más de 8MB', 400);
  const mime = contentType || 'image/jpeg';
  const ext = mime.includes('pdf') ? 'pdf' : mime.split('/')[1] || 'jpg';
  const ruta = `comprobantes/${prefijo}_${Date.now()}.${ext}`;
  await subirArchivo(encryptBuffer(buffer), ruta, 'application/octet-stream');
  return encrypt(ruta);
}

/**
 * Reglas de plata compartidas por alargue y recambio manuales — mismo
 * criterio ya confirmado con el dueño del negocio para "viaje cargado a
 * mano" (ver clientes.routes.ts POST /:telefono/viaje-manual), con una
 * diferencia clave: ACÁ el viaje queda 'programado' de verdad (hay que
 * pasar a buscarlo/entregarlo), no 'completado' — esto es "lo pidió por
 * teléfono, hay que programarlo", no "cargar algo que ya pasó".
 *  - Pagado -> 'validado', nunca cargo de cuenta corriente.
 *  - No pagado + cuenta corriente (aprobada o pendiente) -> cargo directo
 *    (es_cuenta_corriente=TRUE, 'validado'), sin avisar nada — se cobra junto.
 *  - No pagado + ocasional -> 'pendiente' + se le manda la solicitud de pago
 *    por WhatsApp.
 */
function reglasDePago(cont: ContenedorEntregado, pagado: boolean) {
  const esCC = cont.cuenta_corriente_estado === 'aprobada' || cont.cuenta_corriente_estado === 'pendiente';
  const cargoCC = esCC && !pagado;
  const estado = cargoCC || pagado ? 'validado' : 'pendiente';
  return { esCC, cargoCC, estado };
}

async function pedirPagoPorWhatsApp(telefono: string, monto: number, concepto: string, contenedorNumero: string, medioPago: 'efectivo' | 'transferencia'): Promise<void> {
  const cuerpo =
    `📋 Tenés un pago pendiente de *$${monto.toLocaleString('es-AR')}* — ${concepto} del contenedor ${contenedorNumero}.\n\n` +
    (medioPago === 'transferencia'
      ? `${datosBancarios()}\n\nCuando hagas la transferencia, mandanos la foto del comprobante por acá. 📎`
      : '💵 Coordiná con nosotros el pago en efectivo cuando puedas.');
  try {
    await sendText(telefono, cuerpo);
  } catch (e) {
    const motivo = motivoErrorWa(e);
    console.error('Error mandando solicitud de pago manual:', motivo);
    notificarEnvioFallido(telefono, telefono, `solicitud de pago de ${concepto}`, motivo).catch((e2) =>
      console.error('Error registrando alerta de envío fallido:', e2),
    );
  }
}

/**
 * GET /api/contenedores — Listar todos los contenedores.
 * `actualizado_por` se guarda como "chofer:<uuid>"/"operador:<uuid>" (para
 * poder resolverlo bien acá) — sin este JOIN se mostraba el uuid crudo en el
 * panel y parecía un valor cifrado/ilegible.
 */
contenedoresRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT c.numero, c.tamano, c.estado, c.cliente_id, c.vence_en, c.actualizado_en, c.creado_en,
            -- Vista "por contrato" (Disponible/Alquilado/Para retirar/Yendo a
            -- vaciar/Vencido) derivada del estado técnico, sin tocarlo —
            -- misma expresión duplicada en viajes.routes.ts (columna
            -- contenedor_estado) y en dashboard.routes.ts (GET /contenedores,
            -- agrupada); mantener las tres en sync.
            CASE
              WHEN EXISTS (
                SELECT 1 FROM viajes v
                 WHERE v.contenedor_numero = c.numero AND v.tipo = 'retiro' AND v.estado = 'en_curso'
              ) THEN 'yendo_a_vaciar'
              -- "Para retirar" es solo cuando el retiro ya está próximo/vencido
              -- (fecha <= hoy) — desde que el retiro automático por
              -- vencimiento se crea con anticipación (ver jobs/alertas.cron.ts),
              -- existe un viaje 'retiro' programado desde el día que se
              -- entrega, y sin este filtro un contenedor recién alquilado ya
              -- aparecía "para retirar" aunque faltaran semanas.
              WHEN EXISTS (
                SELECT 1 FROM viajes v
                 WHERE v.contenedor_numero = c.numero AND v.tipo = 'retiro' AND v.estado = 'programado' AND v.fecha <= $1::date
              ) THEN 'para_retirar'
              WHEN c.estado = 'entregado' AND c.vence_en IS NOT NULL AND c.vence_en < now() THEN 'vencido'
              WHEN c.estado = 'entregado' THEN 'alquilado'
              -- Técnicamente 'disponible' (en depósito, nadie lo tiene) pero
              -- ya elegido para una entrega de OTRA ruta que todavía no se
              -- confirmó — por eso no aparece como opción al armar cualquier
              -- otra ruta (ver disponiblesRows en rutas.routes.ts), aunque acá
              -- siga figurando "disponible" y confundía al operador. "va" ya
              -- trae el viaje activo más reciente de este contenedor.
              WHEN c.estado = 'disponible' AND va.tipo = 'entrega' THEN 'preasignado'
              ELSE c.estado::text
            END AS estado_contrato,
            CASE
              WHEN c.actualizado_por LIKE 'chofer:%'   THEN COALESCE(ch.nombre, 'Chofer eliminado')
              WHEN c.actualizado_por LIKE 'operador:%' THEN COALESCE(u.nombre, 'Usuario eliminado')
              WHEN c.actualizado_por = 'validacion_pago' THEN 'Sistema (validación de pago)'
              ELSE c.actualizado_por
            END AS actualizado_por,
            va.tipo AS viaje_tipo, vch.nombre AS chofer_asignado,
            -- Cliente/dirección de la visita activa (reservado/entregado/
            -- retirado): contenedores.cliente_id nunca se llega a completar
            -- en ningún flujo (queda siempre NULL salvo cuando se limpia a
            -- mano), así que el dato real hay que sacarlo del viaje vigente.
            va.cliente_telefono, va.destino_direccion, va.zona,
            COALESCE(cl.nombre, va.cliente_telefono) AS cliente_nombre,
            -- Teléfono del cliente de la entrega vigente si todavía NO está
            -- cargado en Clientes (null si existe): el panel lo manda a crearlo
            -- antes de dejar gestionar nada.
            (SELECT CASE WHEN EXISTS (SELECT 1 FROM clientes cx WHERE cx.telefono = ue.cliente_telefono)
                         THEN NULL ELSE ue.cliente_telefono END
               FROM viajes ue
              WHERE ue.contenedor_numero = c.numero AND ue.tipo = 'entrega' AND ue.estado <> 'cancelado'
              ORDER BY ue.creado_en DESC LIMIT 1) AS gestion_cliente_faltante
       FROM contenedores c
       LEFT JOIN choferes ch ON c.actualizado_por LIKE 'chofer:%' AND ch.id::text = substring(c.actualizado_por FROM 8)
       LEFT JOIN usuarios u  ON c.actualizado_por LIKE 'operador:%' AND u.id::text = substring(c.actualizado_por FROM 10)
       -- Viaje activo (entrega o retiro) que tiene hoy asignado este contenedor,
       -- para que el operador vea de un vistazo si quedó "huérfano" sin chofer,
       -- y de quién/adónde es la entrega en curso.
       LEFT JOIN LATERAL (
         SELECT v.tipo, v.chofer_id, v.cliente_telefono, v.destino_direccion, v.zona
           FROM viajes v
          WHERE v.contenedor_numero = c.numero AND v.estado IN ('programado', 'en_curso')
          ORDER BY v.creado_en DESC LIMIT 1
       ) va ON true
       LEFT JOIN choferes vch ON vch.id = va.chofer_id
       LEFT JOIN clientes cl ON cl.telefono = va.cliente_telefono
      ORDER BY c.actualizado_en DESC`,
    [hoyMendozaISO()],
  );
  res.json(rows);
});

/**
 * GET /api/contenedores/:numero/historial — historial completo de estados
 * de una unidad, con quién hizo cada cambio y agrupado por ticket (cada
 * ciclo de alquiler: reserva → entrega → retiro → disponible).
 *
 * "Quién" se resuelve igual que en GET /api/contenedores (actualizado_por
 * con formato "chofer:<uuid>"/"operador:<uuid>"). Para filas viejas,
 * anteriores a que el trigger guardara actualizado_por en esta tabla, se
 * lo reconstruye a partir de la nota automática vieja ("auto: chofer:...")
 * o, en su defecto, del chofer_id que sí quedó guardado.
 *
 * El ticket se resuelve como "el más reciente abierto hasta ese momento"
 * para ese contenedor (no hay ticket_id en esta tabla, y en la práctica
 * los tickets nunca se marcan 'cerrado' al terminar el ciclo — ver POST
 * /api/tickets/:id/cerrar, que es un paso manual aparte — así que no se
 * puede confiar en el rango [creado_en, cerrado_en) para no solapar).
 *
 * No se puede resolver directo por tickets.contenedor_numero: desde la
 * migración 0023 esa columna queda NULL salvo que el operador haya elegido
 * el contenedor a mano al validar el pago (ya no es lo habitual, se asigna
 * después al armar la ruta). Por eso se pasa primero por viajes —ahí sí
 * queda el contenedor real una vez asignado— y de ahí se llega al ticket
 * por pago_id (mismo pago que generó el ticket, ver pagos.routes.ts /validar).
 */
contenedoresRouter.get('/:numero/historial', async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT h.id, h.estado, h.creado_en,
            CASE
              WHEN efectivo.actualizado_por LIKE 'chofer:%'   THEN COALESCE(ch.nombre, 'Chofer eliminado')
              WHEN efectivo.actualizado_por LIKE 'operador:%' THEN COALESCE(u.nombre, 'Usuario eliminado')
              WHEN efectivo.actualizado_por = 'validacion_pago' THEN 'Sistema (validación de pago)'
              WHEN efectivo.actualizado_por = 'cierre_ticket'   THEN 'Sistema (cierre de ticket)'
              WHEN efectivo.actualizado_por IS NULL OR efectivo.actualizado_por = 'sistema' THEN 'Sistema'
              ELSE efectivo.actualizado_por
            END AS realizado_por,
            t.id AS ticket_id, pe.zona AS ticket_zona, p.cliente_telefono AS ticket_cliente_telefono
       FROM historial_contenedores h
       CROSS JOIN LATERAL (
         SELECT COALESCE(
           h.actualizado_por,
           CASE WHEN h.nota LIKE 'auto: %' THEN substring(h.nota FROM 7) END,
           CASE WHEN h.chofer_id IS NOT NULL THEN 'chofer:' || h.chofer_id::text END
         ) AS actualizado_por
       ) efectivo
       LEFT JOIN choferes ch ON efectivo.actualizado_por LIKE 'chofer:%'   AND ch.id::text = substring(efectivo.actualizado_por FROM 8)
       LEFT JOIN usuarios u  ON efectivo.actualizado_por LIKE 'operador:%' AND u.id::text = substring(efectivo.actualizado_por FROM 10)
       LEFT JOIN LATERAL (
         SELECT v.pago_id
           FROM viajes v
          WHERE v.contenedor_numero = h.numero_contenedor AND v.creado_en <= h.creado_en
          ORDER BY v.creado_en DESC
          LIMIT 1
       ) vg ON true
       LEFT JOIN tickets t  ON t.pago_id = vg.pago_id
       LEFT JOIN pedidos pe ON pe.id = t.pedido_id
       LEFT JOIN pagos   p  ON p.id  = t.pago_id
      WHERE h.numero_contenedor = $1
      ORDER BY h.creado_en DESC`,
    [req.params.numero],
  );
  res.json(rows);
});

const nuevoSchema = z.object({
  numero: z.string().min(1).max(50),
});

/** Tamaños de contenedor en m³ — mismo CHECK que la columna contenedores.tamano. */
const tamanoSchema = z.object({
  tamano: z.union([z.literal(5), z.literal(7), z.literal(9)]),
});
const crearSchema = nuevoSchema.merge(tamanoSchema);

/** POST /api/contenedores — Crear un contenedor (solo admin/operador). */
contenedoresRouter.post('/', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = crearSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });

  const { numero, tamano } = parsed.data;
  // Convertir a mayúsculas para mantener consistencia, aunque no esté forzado a MSKU
  const numeroNormalizado = numero.trim().toUpperCase();

  try {
    const [row] = await query(
      `INSERT INTO contenedores (numero, tamano) VALUES ($1, $2) RETURNING *`,
      [numeroNormalizado, tamano]
    );
    res.status(201).json(row);
  } catch (e: any) {
    if (e.code === '23505') { // Unique violation
      res.status(409).json({ error: 'El contenedor ya existe' });
    } else {
      console.error('Error al insertar contenedor:', e);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }
});

/**
 * POST /api/contenedores/:numero/confirmar-retiro — respaldo manual para el
 * operador: el chofer ahora confirma solo por WhatsApp que vació el
 * contenedor ("🗑️ Ya vacié", ver flows/chofer.flow.ts), que es el camino
 * normal. Esta ruta queda para casos raros donde el chofer no puede usar el
 * bot (sin señal, error, etc.) y un operador tiene que forzarlo a mano.
 */
contenedoresRouter.post(
  '/:numero/confirmar-retiro',
  requireRol('admin', 'operador'),
  async (req: Request, res: Response) => {
    const resultado = await finalizarRetiro(req.params.numero, `operador:${req.user!.id}`);
    if ('error' in resultado) {
      const status = resultado.error.includes('pendiente de confirmación') ? 404 : 409;
      return res.status(status).json({ error: resultado.error });
    }
    res.json(resultado);
  },
);

/**
 * PATCH /api/contenedores/:numero — corregir el número (ej. error de tipeo
 * al darlo de alta). Es un UPDATE directo de la PK: las FK que apuntan acá
 * (historial_contenedores, pedidos, pagos, tickets, viajes) tienen
 * ON UPDATE CASCADE desde la migración 0040, así que todo lo que ya
 * referenciaba el número viejo queda consistente solo, sin importar si el
 * contenedor ya tuvo movimientos o no.
 */
contenedoresRouter.patch('/:numero', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const numeroNuevo = parsed.data.numero.trim().toUpperCase();
  try {
    const [row] = await query(
      `UPDATE contenedores SET numero = $1 WHERE numero = $2 RETURNING *`,
      [numeroNuevo, req.params.numero],
    );
    if (!row) return res.status(404).json({ error: 'Contenedor inexistente' });
    res.json(row);
  } catch (e: any) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un contenedor con ese número' });
    console.error('Error al renombrar contenedor:', e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

/**
 * PATCH /api/contenedores/:numero/tamano — cargar o corregir el tamaño (m³).
 * Sirve también para completar los contenedores dados de alta antes de que
 * existiera la columna (quedaron con tamano NULL).
 */
contenedoresRouter.patch('/:numero/tamano', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = tamanoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Tamaño inválido' });
  const [row] = await query(
    `UPDATE contenedores SET tamano = $1 WHERE numero = $2 RETURNING *`,
    [parsed.data.tamano, req.params.numero],
  );
  if (!row) return res.status(404).json({ error: 'Contenedor inexistente' });
  res.json(row);
});

/**
 * DELETE /api/contenedores/:numero — borra un contenedor dado de alta por
 * error. Solo se permite si nunca tuvo un movimiento real (ningún viaje,
 * pago, ticket o pedido lo referenció jamás) — si lo hubo, borrarlo se
 * llevaría puesto ese historial de negocio (historial_contenedores cascadea
 * al borrar). Un contenedor que sí se usó y ya no sirve se saca de
 * circulación con el estado 'mantenimiento', no borrándolo.
 */
contenedoresRouter.delete('/:numero', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const numero = req.params.numero;
  const [usado] = await query<{ existe: boolean }>(
    `SELECT
       EXISTS(SELECT 1 FROM viajes WHERE contenedor_numero = $1) OR
       EXISTS(SELECT 1 FROM pagos WHERE contenedor_numero = $1) OR
       EXISTS(SELECT 1 FROM tickets WHERE contenedor_numero = $1) OR
       EXISTS(SELECT 1 FROM pedidos WHERE contenedor_recambio_numero = $1)
       AS existe`,
    [numero],
  );
  if (usado?.existe) {
    return res.status(409).json({ error: 'Este contenedor ya tiene movimientos registrados — no se puede eliminar. Si ya no sirve, marcalo en mantenimiento.' });
  }
  const [row] = await query('DELETE FROM contenedores WHERE numero = $1 RETURNING numero', [numero]);
  if (!row) return res.status(404).json({ error: 'Contenedor inexistente' });
  res.json({ ok: true });
});

const estadoSchema = z.object({ estado: z.enum(['mantenimiento', 'disponible']) });

/**
 * PATCH /api/contenedores/:numero/estado — sacar un contenedor de servicio
 * o devolverlo (solo admin/operador). El trigger fn_validar_transicion_contenedor
 * ya sabe que 'mantenimiento' solo se puede pisar desde 'disponible'/'retirado',
 * y que desde 'mantenimiento' solo se vuelve a 'disponible' — acá no se
 * duplica esa matriz, si la transición no es válida el trigger la rechaza
 * y se traduce a un 409 legible. Un contenedor 'reservado'/'entregado' (en
 * medio de un ciclo de alquiler) no se puede pasar a mantenimiento sin
 * primero cerrar ese ciclo — evita dejar un viaje activo "huérfano".
 */
contenedoresRouter.patch(
  '/:numero/estado',
  requireRol('admin', 'operador'),
  async (req: Request, res: Response) => {
    const parsed = estadoSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Estado inválido' });
    try {
      const [row] = await query(
        `UPDATE contenedores SET estado = $1, actualizado_por = $2 WHERE numero = $3 RETURNING *`,
        [parsed.data.estado, `operador:${req.user!.id}`, req.params.numero],
      );
      if (!row) return res.status(404).json({ error: 'Contenedor inexistente' });
      res.json(row);
    } catch (e: any) {
      if (e.code === '23514') return res.status(409).json({ error: e.message });
      console.error('Error al cambiar estado del contenedor:', e);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Gestionar contenedor: los 3 flujos que el bot ya resuelve solo por
// WhatsApp (retiro anticipado, alargue, recambio), pero armados a mano desde
// el panel — para un cliente que llama y prefiere saltearse el bot. A
// diferencia de clientes.routes.ts POST /:telefono/viaje-manual (que carga
// algo que YA pasó, sin tocar nada operativo), acá el viaje queda
// 'programado' de verdad: mueve la bolsa / estira el vencimiento / puede
// asignarse a un chofer, igual que si lo hubiera pedido el cliente por
// WhatsApp.
// ─────────────────────────────────────────────────────────────────────────

const retiroAnticipadoSchema = z.object({ fecha: z.string() });

/**
 * POST /api/contenedores/:numero/retiro-anticipado — sin costo (no se
 * descuenta del alquiler, mismo criterio que pedirRetiro.flow.ts). La fecha
 * tiene que ser antes del vencimiento ya pactado — si el cliente llama
 * después de vencido, es un retiro normal, no "anticipado".
 */
contenedoresRouter.post('/:numero/retiro-anticipado', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = retiroAnticipadoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Falta la fecha' });
  const { fecha } = parsed.data;
  const numero = req.params.numero;

  const cont = await obtenerContenedorEntregado(numero);
  if (!cont) return res.status(404).json({ error: 'Este contenedor no está entregado a ningún cliente ahora mismo.' });
  if (rechazarSiNoGestionable(cont, res)) return;
  if (!cont.vence_en) return res.status(409).json({ error: 'Este contenedor no tiene fecha de vencimiento cargada.' });
  const hoy = hoyMendozaISO();
  const venceFecha = fechaMendoza(cont.vence_en);
  if (fecha < hoy) return res.status(400).json({ error: 'La fecha no puede ser anterior a hoy.' });
  if (fecha >= venceFecha) return res.status(400).json({ error: `Tiene que ser antes del vencimiento (${formatearFechaCorta(cont.vence_en)}).` });

  try {
    const row = await withTx(async (c) => {
      const activo = await buscarRetiroActivo(c, numero);
      if (activo?.estado === 'en_curso') fail('Ya hay un chofer en camino a buscar este contenedor — no se puede reprogramar.');
      if (activo) {
        const { rows } = await c.query(
          `UPDATE viajes SET fecha = $1 WHERE id = $2 RETURNING *`,
          [fecha, activo.id],
        );
        return rows[0];
      }
      const vaciadero = await resolverUbicacion('vaciadero');
      const { rows } = await c.query(
        `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, notas, ubicacion_id, ubicacion_direccion, canal)
         VALUES ('retiro', $1, $2, $3, $4, $5, $6, $7, 'Retiro anticipado cargado a mano desde Contenedores', $8, $9, 'panel') RETURNING *`,
        [fecha, numero, cont.cliente_telefono, cont.zona, cont.destino_direccion, cont.destino_lat, cont.destino_lng,
         vaciadero?.id ?? null, vaciadero?.direccion ?? null],
      );
      return rows[0];
    });
    emitRecursoActualizado('viajes');
    res.json(row);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('Error programando retiro anticipado:', e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

const pagoManualSchema = z.object({
  medio_pago: z.enum(['efectivo', 'transferencia']),
  pagado: z.boolean(),
  comprobante_base64: z.string().optional(),
  comprobante_content_type: z.string().optional(),
});

/**
 * POST /api/contenedores/:numero/alargue — siempre DIAS_ALARGUE días desde
 * el vencimiento actual (el cliente no elige cuánto), al PORCENTAJE_ALARGUE
 * de la tarifa vigente de su zona — mismos valores que usa el bot (ver
 * bot.config.ts). A diferencia del alargue pedido por WhatsApp (que cancela
 * el retiro automático y deja que el cron lo vuelva a crear, ver
 * cancelarRetiroAutomatico), acá se reprograma directo a la fecha nueva —
 * el operador quiere ver el resultado ya mismo, no esperar la próxima
 * corrida del cron.
 */
contenedoresRouter.post('/:numero/alargue', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = pagoManualSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const v = parsed.data;
  const numero = req.params.numero;

  const cont = await obtenerContenedorEntregado(numero);
  if (!cont) return res.status(404).json({ error: 'Este contenedor no está entregado a ningún cliente ahora mismo.' });
  if (rechazarSiNoGestionable(cont, res)) return;
  if (!cont.vence_en) return res.status(409).json({ error: 'Este contenedor no tiene fecha de vencimiento cargada.' });
  if (!cont.zona) return res.status(409).json({ error: 'Este contenedor no tiene zona cargada — no se puede calcular el costo del alargue.' });

  const [tarifa] = await query<{ precio: string }>(
    'SELECT precio FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [cont.zona],
  );
  if (!tarifa) return res.status(409).json({ error: `No hay tarifa activa cargada para ${cont.zona}.` });
  const monto = Math.round(Number(tarifa.precio) * PORCENTAJE_ALARGUE);

  const { cargoCC, estado } = reglasDePago(cont, v.pagado);
  let urlComprobante: string | null = null;
  if (v.pagado && v.medio_pago === 'transferencia' && v.comprobante_base64) {
    try {
      urlComprobante = await subirComprobanteManual(v.comprobante_base64, v.comprobante_content_type, `alargue_${numero}`);
    } catch (e: any) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('Error subiendo comprobante de alargue:', e);
      return res.status(502).json({ error: 'No se pudo guardar el comprobante' });
    }
  }

  try {
    const resultado = await withTx(async (c) => {
      const activo = await buscarRetiroActivo(c, numero);
      if (activo?.estado === 'en_curso') fail('Ya hay un chofer en camino a buscar este contenedor — no se puede alargar ahora.');

      const { rows: contRows } = await c.query<{ vence_en: Date }>(
        `UPDATE contenedores SET vence_en = vence_en + make_interval(days => $2) WHERE numero = $1 RETURNING vence_en`,
        [numero, DIAS_ALARGUE],
      );
      const nuevoVenceEn = contRows[0].vence_en;
      const nuevaFecha = diaHabilDesde(fechaMendoza(nuevoVenceEn));

      const { rows: pagoRows } = await c.query<{ id: string }>(
        `INSERT INTO pagos (cliente_telefono, tipo, contenedor_numero, monto, medio_pago, estado, efectivo_cobrado, es_cuenta_corriente, url_comprobante)
         VALUES ($1, 'alargue_retiro', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [cont.cliente_telefono, numero, monto, v.medio_pago, estado, v.pagado && v.medio_pago === 'efectivo', cargoCC, urlComprobante],
      );
      const pagoId = pagoRows[0].id;

      if (activo) {
        await c.query(`UPDATE viajes SET fecha = $1, pago_id = $2 WHERE id = $3`, [nuevaFecha, pagoId, activo.id]);
      } else {
        const vaciadero = await resolverUbicacion('vaciadero');
        await c.query(
          `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, pago_id, notas, ubicacion_id, ubicacion_direccion, canal)
           VALUES ('retiro', $1, $2, $3, $4, $5, $6, $7, $8, 'Alargue cargado a mano desde Contenedores', $9, $10, 'panel')`,
          [nuevaFecha, numero, cont.cliente_telefono, cont.zona, cont.destino_direccion, cont.destino_lat, cont.destino_lng,
           pagoId, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
        );
      }
      return { venceEn: nuevoVenceEn, pagoId };
    });

    if (!v.pagado && !reglasDePago(cont, v.pagado).esCC) {
      await pedirPagoPorWhatsApp(cont.cliente_telefono, monto, 'extensión de retiro', numero, v.medio_pago);
    }
    emitRecursoActualizado('contenedores');
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('pagos');
    res.json({ ok: true, vence_en: resultado.venceEn, pago_id: resultado.pagoId, monto });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('Error aplicando alargue manual:', e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

const recambioSchema = pagoManualSchema.extend({
  fecha: z.string(),
  contenedor_numero_entrega: z.string().min(1),
});

/**
 * POST /api/contenedores/:numero/recambio — misma dirección/zona (y por lo
 * tanto mismo precio, tarifa completa de esa zona) del contenedor que ya
 * tiene; la fecha tiene que caer entre hoy y el vencimiento ya pactado — un
 * recambio después de vencido ya no es "recambio", es un retiro + una
 * entrega nueva aparte.
 */
contenedoresRouter.post('/:numero/recambio', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = recambioSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const v = parsed.data;
  const numero = req.params.numero;

  const cont = await obtenerContenedorEntregado(numero);
  if (!cont) return res.status(404).json({ error: 'Este contenedor no está entregado a ningún cliente ahora mismo.' });
  if (rechazarSiNoGestionable(cont, res)) return;
  if (!cont.zona) return res.status(409).json({ error: 'Este contenedor no tiene zona cargada — no se puede calcular el precio del recambio.' });
  if (v.contenedor_numero_entrega.trim().toUpperCase() === numero.toUpperCase()) {
    return res.status(400).json({ error: 'El contenedor que se deja no puede ser el mismo que se retira.' });
  }
  const hoy = hoyMendozaISO();
  if (v.fecha < hoy) return res.status(400).json({ error: 'La fecha no puede ser anterior a hoy.' });
  if (cont.vence_en && v.fecha > fechaMendoza(cont.vence_en)) {
    return res.status(400).json({ error: `Tiene que ser hasta el vencimiento (${formatearFechaCorta(cont.vence_en)}) — después de esa fecha ya no es un recambio.` });
  }

  const [tarifa] = await query<{ precio: string }>(
    'SELECT precio FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [cont.zona],
  );
  if (!tarifa) return res.status(409).json({ error: `No hay tarifa activa cargada para ${cont.zona}.` });
  const monto = Number(tarifa.precio);

  const { cargoCC, estado } = reglasDePago(cont, v.pagado);
  let urlComprobante: string | null = null;
  if (v.pagado && v.medio_pago === 'transferencia' && v.comprobante_base64) {
    try {
      urlComprobante = await subirComprobanteManual(v.comprobante_base64, v.comprobante_content_type, `recambio_${numero}`);
    } catch (e: any) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('Error subiendo comprobante de recambio:', e);
      return res.status(502).json({ error: 'No se pudo guardar el comprobante' });
    }
  }

  try {
    const resultado = await withTx(async (c) => {
      const activo = await buscarRetiroActivo(c, numero);
      if (activo?.estado === 'en_curso') fail('Ya hay un chofer en camino a buscar este contenedor — no se puede recambiar ahora.');

      const actualizadoPor = `operador:${req.user!.id}`;
      await reservarParaEntrega(c, v.contenedor_numero_entrega.trim().toUpperCase(), v.fecha, actualizadoPor);

      const { rows: pagoRows } = await c.query<{ id: string }>(
        `INSERT INTO pagos (cliente_telefono, tipo, monto, medio_pago, estado, efectivo_cobrado, es_cuenta_corriente, url_comprobante)
         VALUES ($1, 'flete', $2, $3, $4, $5, $6, $7) RETURNING id`,
        [cont.cliente_telefono, monto, v.medio_pago, estado, v.pagado && v.medio_pago === 'efectivo', cargoCC, urlComprobante],
      );
      const pagoId = pagoRows[0].id;

      const grupoId = randomUUID();
      const deposito = await resolverUbicacion('deposito');
      let retiroId: string;
      if (activo) {
        await c.query(
          `UPDATE viajes SET fecha = $1, grupo_id = $2, importe = $3, pago_id = $4, es_cuenta_corriente = $5 WHERE id = $6`,
          [v.fecha, grupoId, monto, pagoId, cargoCC, activo.id],
        );
        retiroId = activo.id;
      } else {
        const vaciadero = await resolverUbicacion('vaciadero');
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, importe, es_cuenta_corriente, pago_id, grupo_id, notas, ubicacion_id, ubicacion_direccion, canal)
           VALUES ('retiro', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Recambio cargado a mano desde Contenedores', $12, $13, 'panel') RETURNING id`,
          [v.fecha, numero, cont.cliente_telefono, cont.zona, cont.destino_direccion, cont.destino_lat, cont.destino_lng,
           monto, cargoCC, pagoId, grupoId, vaciadero?.id ?? null, vaciadero?.direccion ?? null],
        );
        retiroId = rows[0].id;
      }
      await c.query(
        `INSERT INTO viajes (tipo, fecha, contenedor_numero, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, grupo_id, notas, ubicacion_id, ubicacion_direccion, canal)
         VALUES ('entrega', $1, $2, $3, $4, $5, $6, $7, $8, 'Recambio cargado a mano desde Contenedores', $9, $10, 'panel')`,
        [v.fecha, v.contenedor_numero_entrega.trim().toUpperCase(), cont.cliente_telefono, cont.zona, cont.destino_direccion,
         cont.destino_lat, cont.destino_lng, grupoId, deposito?.id ?? null, deposito?.direccion ?? null],
      );
      return { retiroId, pagoId };
    });

    if (!v.pagado && !reglasDePago(cont, v.pagado).esCC) {
      await pedirPagoPorWhatsApp(cont.cliente_telefono, monto, 'recambio', numero, v.medio_pago);
    }
    emitRecursoActualizado('contenedores');
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('pagos');
    res.json({ ok: true, pago_id: resultado.pagoId });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === '23503') return res.status(400).json({ error: 'El contenedor que se deja no existe.' });
    console.error('Error armando recambio manual:', e);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});
