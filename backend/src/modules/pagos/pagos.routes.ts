import { randomUUID } from 'crypto';
import express, { Router, Request, Response } from 'express';
import path from 'path';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol, puedeVerComprobante } from '../../middleware/rbac';
import { encrypt, decrypt, encryptBuffer, decryptBuffer } from '../../services/crypto.service';
import { enviarTicketPorWhatsApp } from '../../services/pdf.service';
import { subirArchivo, descargarArchivo } from '../../services/storage.service';
import { sendText, sendButtons, uploadMedia, sendDocument, motivoErrorWa } from '../whatsapp/graphApi';
import { menuChofer } from '../whatsapp/flows/chofer.flow';
import { avisarChoferRecambio } from '../viajes/viajes.routes';
import { notificarEnvioFallido } from '../whatsapp/alertaEnvio';
import { emitAlerta, emitAlertaActualizada, emitRecursoActualizado } from '../../config/socket';
import { resolverUbicacion } from '../../services/ubicaciones.service';
import { formatearFechaCorta } from '../../services/diasHabiles.service';

export const pagosRouter = Router();
pagosRouter.use(requireAuth);

/** Content-Type a partir de la extensión guardada — comprobantes/facturas solo son imagen o PDF. */
function mimeDeExtension(ext: string): string {
  const e = ext.toLowerCase();
  if (e === '.pdf') return 'application/pdf';
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

/** GET /api/pagos?estado=pendiente — lista de pagos (comprobante enmascarado por rol). */
pagosRouter.get('/', async (req: Request, res: Response) => {
  const estado = (req.query.estado as string) || 'pendiente';
  const rows = await query(
    `SELECT p.id, p.cliente_telefono, p.monto, p.url_comprobante, p.estado, p.creado_en,
            p.titular_transferencia, p.es_cuenta_corriente, p.tipo, p.contenedor_numero,
            pe.zona, pe.precio, td.moneda,
            (SELECT COUNT(*) FROM pagos_adjuntos pa WHERE pa.pago_id = p.id)::int AS adjuntos_count
       FROM pagos p
       LEFT JOIN pedidos pe ON pe.id = p.pedido_id
       LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
      WHERE p.estado = $1 ORDER BY p.creado_en DESC`,
    [estado],
  );
  const rol = req.user!.rol;
  res.json(
    rows.map((r: any) => ({
      ...r,
      // Comprobante: se descifra solo si el rol puede verlo; si no, null.
      url_comprobante: puedeVerComprobante(rol) ? decrypt(r.url_comprobante) : null,
    })),
  );
});

/**
 * GET /api/pagos/:id/comprobante — sirve el archivo del comprobante.
 * Mismo criterio de acceso que el campo url_comprobante (admin/operador/finanzas):
 * NO se monta como estático para no saltear el RBAC.
 */
pagosRouter.get('/:id/comprobante', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const [pago] = await query<{ url_comprobante: string | null }>(
    'SELECT url_comprobante FROM pagos WHERE id = $1',
    [req.params.id],
  );
  if (!pago?.url_comprobante) return res.status(404).json({ error: 'Comprobante no encontrado' });

  // basename() evita path traversal aunque el valor descifrado sea de confianza (defensa en profundidad).
  const filename = path.basename(decrypt(pago.url_comprobante));
  try {
    // El binario se guarda cifrado en el bucket (ver pago.flow.ts); se descifra recién acá, en memoria.
    const buffer = decryptBuffer(await descargarArchivo(`comprobantes/${filename}`));
    res.setHeader('Content-Type', mimeDeExtension(path.extname(filename)));
    res.send(buffer);
  } catch (e) {
    console.error('Error descargando comprobante de Supabase Storage:', e);
    res.status(404).json({ error: 'Archivo no encontrado en el storage' });
  }
});

/**
 * GET /api/pagos/:id/adjuntos — comprobantes adicionales de un pago (llegaron
 * después del primero, ver pago.flow.ts). Mismo criterio de acceso que el
 * comprobante principal (admin/operador/finanzas).
 */
pagosRouter.get('/:id/adjuntos', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const rows = await query<{ id: string; creado_en: string }>(
    'SELECT id, creado_en FROM pagos_adjuntos WHERE pago_id = $1 ORDER BY creado_en',
    [req.params.id],
  );
  res.json(rows);
});

/** GET /api/pagos/:id/adjuntos/:adjuntoId — sirve el archivo de un comprobante adicional. */
pagosRouter.get('/:id/adjuntos/:adjuntoId', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const [adjunto] = await query<{ url_comprobante: string }>(
    'SELECT url_comprobante FROM pagos_adjuntos WHERE id = $1 AND pago_id = $2',
    [req.params.adjuntoId, req.params.id],
  );
  if (!adjunto) return res.status(404).json({ error: 'Adjunto no encontrado' });

  const filename = path.basename(decrypt(adjunto.url_comprobante));
  try {
    const buffer = decryptBuffer(await descargarArchivo(`comprobantes/${filename}`));
    res.setHeader('Content-Type', mimeDeExtension(path.extname(filename)));
    res.send(buffer);
  } catch (e) {
    console.error('Error descargando adjunto de Supabase Storage:', e);
    res.status(404).json({ error: 'Archivo no encontrado en el storage' });
  }
});

const validarSchema = z.object({
  diasDemora: z.coerce.number().int().min(0).optional(),
  choferId: z.string().uuid().optional(),
  venceEn: z.string().optional(), // fecha (YYYY-MM-DD) en la que vence/hay que retirar el contenedor
  contenedorNumero: z.string().optional(), // si no se manda, fn_validar_pago toma el primero disponible
  // Requerida solo si el contenedor elegido está ocupado: para qué fecha se
  // arma la entrega (no puede ser antes de que ese contenedor vuelva).
  fechaEntrega: z.string().optional(),
  // Depósito de donde sale el contenedor (ver ubicaciones.service.ts). Si no
  // se manda y hay uno solo activo, se autoselecciona.
  ubicacionId: z.string().uuid().optional(),
});

/**
 * Le avisa al chofer asignado, por WhatsApp, qué contenedor le toca llevar,
 * a quién y adónde. El chofer confirma el avance ("voy en camino" / "ya
 * entregué") desde su propio menú de WhatsApp (ver chofer.flow.ts) — esos
 * botones ya validan la transición de estado del contenedor.
 */
async function avisarChoferAsignacion(
  choferId: string,
  contenedor: string,
  info: {
    cliente_telefono: string;
    cliente_nombre: string | null;
    destino_lat: string | null;
    destino_lng: string | null;
    destino_direccion: string | null;
  } | undefined,
): Promise<void> {
  const [chofer] = await query<{ telefono: string | null; nombre: string }>(
    'SELECT telefono, nombre FROM choferes WHERE id = $1',
    [choferId],
  );
  if (!chofer?.telefono) return; // chofer sin número vinculado todavía: nada que mandar

  const partesDestino: string[] = [];
  if (info?.destino_direccion) partesDestino.push(info.destino_direccion);
  if (info?.destino_lat && info?.destino_lng) {
    partesDestino.push(`https://www.google.com/maps?q=${info.destino_lat},${info.destino_lng}`);
  }
  const destino = partesDestino.length > 0 ? partesDestino.join('\n') : 'Sin ubicación registrada, coordiná con el cliente.';

  await sendText(
    chofer.telefono,
    `🚚 *Nueva entrega asignada*\n\n` +
      `📦 Contenedor: *${contenedor}*\n` +
      `👤 Cliente: ${info?.cliente_nombre ?? 'Sin nombre registrado'}\n` +
      `📞 Teléfono: ${info?.cliente_telefono ?? '—'}\n` +
      `📍 Destino:\n${destino}`,
  );
  // El menú (botones) sale abajo del aviso: un solo toque para avisar
  // "voy en camino" apenas arranca, sin tener que escribir nada.
  await menuChofer(chofer.telefono, chofer.nombre);
}

/**
 * Aviso liviano (sin el menú de botones de avisarChoferAsignacion, que es
 * para una entrega ya en marcha) cuando el contenedor asignado todavía está
 * ocupado con otro cliente: el chofer se entera de que tiene una entrega
 * reservada para más adelante, pero recién puede actuar cuando el
 * contenedor vuelva (ahí se le vuelve a avisar, ver confirmar-retiro).
 */
async function avisarChoferReservaFutura(choferId: string, contenedor: string, fechaEntrega: string): Promise<void> {
  const [chofer] = await query<{ telefono: string | null }>('SELECT telefono FROM choferes WHERE id = $1', [choferId]);
  if (!chofer?.telefono) return;
  await sendText(
    chofer.telefono,
    `📦 Te quedó reservada una entrega del contenedor *${contenedor}*, pero todavía está con otro cliente.\n` +
      `Prevista para el ${formatearFechaCorta(fechaEntrega)} — te avisamos apenas esté listo para salir.`,
  );
}

/**
 * POST /api/pagos/:id/validar — SÓLO operador/admin/finanzas.
 * Llama a fn_validar_pago (atómico): reserva contenedor + crea ticket, y
 * registra un viaje de entrega sin ruta ni chofer todavía — eso se arma un
 * día antes desde la pestaña Rutas (cola sin rutear). Opcionalmente el
 * operador puede indicar de una el chofer, cuántos días va a demorar el
 * retiro y la fecha de vencimiento del contenedor. Luego genera y envía el
 * PDF por WhatsApp.
 */
/**
 * Cuánto dura un "alargue de retiro" (ver alargarRetiro.flow.ts) — fijo, el
 * cliente no elige la cantidad de días.
 */
const DIAS_ALARGUE = 5;

/**
 * Un pago 'alargue_retiro' no reserva contenedor ni crea ticket — solo suma
 * DIAS_ALARGUE al vencimiento del contenedor que el cliente ya tenía. Se
 * resuelve aparte de fn_validar_pago porque esa función asume que siempre
 * hay un pedido detrás (no es el caso acá).
 */
async function validarAlargue(req: Request, res: Response, pagoId: string): Promise<void> {
  const [pago] = await query<{ contenedor_numero: string | null; cliente_telefono: string }>(
    `UPDATE pagos SET estado = 'validado', validado_por = $2
      WHERE id = $1 AND estado = 'pendiente'
      RETURNING contenedor_numero, cliente_telefono`,
    [pagoId, req.user!.id],
  );
  if (!pago) {
    res.status(409).json({ error: 'Pago inexistente o no está pendiente' });
    return;
  }
  if (!pago.contenedor_numero) {
    res.status(409).json({ error: 'Este alargue no tiene un contenedor asociado' });
    return;
  }

  const [cont] = await query<{ vence_en: string }>(
    `UPDATE contenedores
        SET vence_en = COALESCE(vence_en, now()) + make_interval(days => $2)
      WHERE numero = $1
      RETURNING vence_en`,
    [pago.contenedor_numero, DIAS_ALARGUE],
  );

  await query(`UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'alargue_solicitado' AND referencia_id = $1`, [pagoId]);
  emitAlertaActualizada({ tipo: 'alargue_solicitado', referencia_id: pagoId, estado: 'resuelta' });
  emitRecursoActualizado('contenedores');

  sendText(
    pago.cliente_telefono,
    `✅ ¡Listo! Extendimos *${DIAS_ALARGUE} días* el retiro de tu contenedor *${pago.contenedor_numero}* — ahora vence el ${formatearFechaCorta(cont.vence_en)}.`,
  ).catch((e) => console.error('Error avisando alargue validado:', motivoErrorWa(e)));

  res.json({ ok: true, tipo: 'alargue_retiro', contenedor: pago.contenedor_numero, vence_en: cont.vence_en });
}

pagosRouter.post('/:id/validar', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const pagoId = req.params.id;

  const [pagoTipo] = await query<{ tipo: string }>('SELECT tipo FROM pagos WHERE id = $1', [pagoId]);
  if (!pagoTipo) return res.status(404).json({ error: 'Pago inexistente' });
  if (pagoTipo.tipo === 'alargue_retiro') return validarAlargue(req, res, pagoId);

  const parsed = validarSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { diasDemora, choferId, venceEn, contenedorNumero, fechaEntrega, ubicacionId } = parsed.data;
  const contenedorNorm = contenedorNumero?.trim().toUpperCase() || null;

  // Depósito de donde sale el contenedor de esta entrega. A diferencia de
  // POST /api/viajes, acá no hay todavía un selector en el panel para elegir
  // entre varios — si hay más de uno activo y no se especificó, se deja sin
  // ubicación (se puede completar después desde la pestaña Viajes).
  const ubicacion = await resolverUbicacion('deposito', ubicacionId);

  try {
    // Pre-chequeo liviano: si el contenedor elegido ya está ocupado, la
    // fecha de entrega es obligatoria y no puede ser anterior a su vuelta.
    // La comprobación definitiva (con lock de fila) la hace fn_validar_pago
    // más abajo — esto solo evita validar el pago y quedarnos sin poder
    // crear el viaje futuro después por un dato faltante.
    if (contenedorNorm) {
      const [contPrevio] = await query<{ estado: string; vence_en: string | null }>(
        'SELECT estado, vence_en FROM contenedores WHERE numero = $1',
        [contenedorNorm],
      );
      if (contPrevio && contPrevio.estado !== 'disponible') {
        if (!fechaEntrega) {
          return res.status(400).json({ error: 'Ese contenedor está ocupado: indicá la fecha de entrega (no puede ser antes de que vuelva).' });
        }
        if (contPrevio.vence_en && fechaEntrega < new Date(contPrevio.vence_en).toISOString().slice(0, 10)) {
          return res.status(400).json({
            error: `Ese contenedor vuelve el ${formatearFechaCorta(contPrevio.vence_en)}; elegí esa fecha o una posterior.`,
          });
        }
      }
    }

    const [result] = await query<{ ticket_id: string; contenedor: string; reservado_ahora: boolean }>(
      'SELECT * FROM fn_validar_pago($1, $2, $3)',
      [pagoId, req.user!.id, contenedorNorm],
    );

    // Datos para el ticket + para avisarle al chofer adónde tiene que llevar el contenedor.
    const [info] = await query<{
      cliente_telefono: string;
      cliente_nombre: string | null;
      zona: string;
      precio: string;
      moneda: string | null;
      destino_lat: string | null;
      destino_lng: string | null;
      destino_direccion: string | null;
      horario_preferido: string | null;
      es_cuenta_corriente: boolean;
      pedido_tipo: string | null;
      contenedor_recambio_numero: string | null;
      fecha_entrega: string | null;
    }>(
      `SELECT p.cliente_telefono, pe.cliente_nombre, pe.zona, pe.precio, td.moneda,
              pe.destino_lat, pe.destino_lng, pe.destino_direccion, pe.horario_preferido, p.es_cuenta_corriente,
              pe.tipo AS pedido_tipo, pe.contenedor_recambio_numero, pe.fecha_entrega
         FROM pagos p
         LEFT JOIN pedidos pe ON pe.id = p.pedido_id
         LEFT JOIN tarifas_departamento td ON td.departamento = pe.zona
        WHERE p.id = $1`,
      [pagoId],
    );
    const esRecambio = info?.pedido_tipo === 'recambio' && !!info?.contenedor_recambio_numero;

    // Primera vez que se le valida un pago a cuenta corriente: queda
    // aprobado para las próximas veces sin que el cliente tenga que
    // volver a pedirlo (sigue pasando por esta misma validación manual).
    if (info?.es_cuenta_corriente) {
      await query(
        `UPDATE clientes SET cuenta_corriente_estado = 'aprobada'
          WHERE telefono = $1 AND cuenta_corriente_estado <> 'aprobada'`,
        [info.cliente_telefono],
      );
    }

    if (result.contenedor && result.reservado_ahora) {
      if (venceEn) {
        await query('UPDATE contenedores SET vence_en = $1 WHERE numero = $2', [venceEn, result.contenedor]);
      }
    }

    if (esRecambio) {
      const grupoId = randomUUID();
      const vaciadero = await resolverUbicacion('vaciadero');
      await query(
        `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, horario_preferido, estado, notas, grupo_id, ubicacion_id, ubicacion_direccion, pago_id)
         VALUES ('retiro', COALESCE($1, CURRENT_DATE), $2, $3, $4, $5, $6, $7, $8, $9, 'programado', 'Creado al validar el pago (recambio)', $10, $11, $12, $13)`,
        [venceEn ?? null, choferId ?? null, info!.contenedor_recambio_numero, info?.cliente_telefono ?? null, info?.zona ?? null,
         info?.destino_direccion ?? null, info?.destino_lat ?? null, info?.destino_lng ?? null, info?.horario_preferido ?? null, grupoId, vaciadero?.id ?? null, vaciadero?.direccion ?? null, pagoId],
      );
      await query(
        `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, cliente_telefono, zona, destino_direccion, destino_lat, destino_lng, horario_preferido, estado, notas, grupo_id, ubicacion_id, ubicacion_direccion, pago_id)
         VALUES ('entrega', COALESCE($1, CURRENT_DATE), $2, $3, $4, $5, $6, $7, $8, $9, 'programado', 'Creado al validar el pago (recambio)', $10, $11, $12, $13)`,
        [venceEn ?? null, choferId ?? null, result.contenedor ?? null, info?.cliente_telefono ?? null, info?.zona ?? null,
         info?.destino_direccion ?? null, info?.destino_lat ?? null, info?.destino_lng ?? null, info?.horario_preferido ?? null, grupoId, ubicacion?.id ?? null, ubicacion?.direccion ?? null, pagoId],
      );

      if (choferId && result.contenedor) {
        avisarChoferRecambio(choferId, info!.contenedor_recambio_numero!, result.contenedor, ubicacion?.id ?? null, info?.destino_direccion ?? null).catch((e) => {
          const motivo = motivoErrorWa(e);
          console.error('Error avisando al chofer el recambio:', motivo);
          notificarEnvioFallido(result.contenedor, `chofer del recambio ${info!.contenedor_recambio_numero}`, 'aviso de recambio asignado', motivo).catch(
            (e2) => console.error('Error registrando alerta de envío fallido:', e2),
          );
        });
      }
    } else {
      // El operador puede pisarla a mano (fechaEntrega/venceEn en el body),
      // pero si no la manda hay que respetar el día que el cliente ya eligió
      // al pedir el pedido (pedidos.fecha_entrega) — antes se perdía y el
      // viaje caía en CURRENT_DATE.
      const fechaViaje = fechaEntrega ?? venceEn ?? info?.fecha_entrega ?? null;
      await query(
        `INSERT INTO viajes (tipo, fecha, chofer_id, contenedor_numero, cliente_telefono, zona, estado, notas, ubicacion_id, ubicacion_direccion, destino_direccion, destino_lat, destino_lng, horario_preferido, pago_id)
         VALUES ('entrega', COALESCE($1, CURRENT_DATE), $2, $3, $4, $5, 'programado', $6, $7, $8, $9, $10, $11, $12, $13)`,
        [fechaViaje, choferId ?? null, result.contenedor ?? null, info?.cliente_telefono ?? null, info?.zona ?? null,
         result.contenedor ? (result.reservado_ahora ? 'Creado al validar el pago' : 'Reservado al validar el pago; contenedor ocupado, pendiente de que vuelva') : 'Creado al validar el pago (en bolsa sin rutear)',
         ubicacion?.id ?? null, ubicacion?.direccion ?? null, info?.destino_direccion ?? null, info?.destino_lat ?? null, info?.destino_lng ?? null, info?.horario_preferido ?? null, pagoId],
      );

      if (choferId && result.contenedor) {
        if (result.reservado_ahora) {
          avisarChoferAsignacion(choferId, result.contenedor, info).catch((e) => {
            const motivo = motivoErrorWa(e);
            console.error('Error avisando al chofer la asignación:', motivo);
            notificarEnvioFallido(result.contenedor, `chofer de ${result.contenedor}`, 'aviso de entrega asignada', motivo).catch(
              (e2) => console.error('Error registrando alerta de envío fallido:', e2),
            );
          });
        } else if (fechaEntrega) {
          avisarChoferReservaFutura(choferId, result.contenedor, fechaEntrega).catch((e) =>
            console.error('Error avisando reserva futura al chofer:', motivoErrorWa(e)),
          );
        }
      }
    }

    if (diasDemora != null && info?.cliente_telefono) {
      sendText(
        info.cliente_telefono,
        `📅 Tu contenedor se pasará a recoger en *${diasDemora} día${diasDemora === 1 ? '' : 's'}* desde la entrega del mismo.`,
      ).catch((e) => console.error('Error avisando plazo de retiro:', motivoErrorWa(e)));
    }

    // Envío del PDF (no bloqueante para la respuesta HTTP)
    enviarTicketPorWhatsApp({
      ticketId: result.ticket_id,
      contenedor: result.contenedor,
      zona: info?.zona ?? '—',
      precio: info?.precio,
      moneda: info?.moneda ?? undefined,
      clienteTelefono: info.cliente_telefono,
      fecha: new Date(),
    }).catch((e) => {
      const motivo = motivoErrorWa(e);
      console.error('Error enviando ticket:', motivo);
      notificarEnvioFallido(result.ticket_id, info.cliente_telefono, 'envío de ticket/comprobante de entrega', motivo).catch(
        (e2) => console.error('Error registrando alerta de envío fallido:', e2),
      );
    });

    // fn_validar_pago ya resolvió la alerta atómicamente en SQL (transferencia
    // o cuenta corriente, ver migración 0013); acá solo se avisa por socket a
    // los demás operadores (el que hizo la acción ya actualizó su propia
    // pantalla de forma optimista).
    emitAlertaActualizada({
      tipo: info?.es_cuenta_corriente ? 'cuenta_corriente_solicitada' : 'pago_pendiente_validacion',
      referencia_id: pagoId,
      estado: 'resuelta',
    });

    res.json({ ok: true, ticket_id: result.ticket_id, contenedor: result.contenedor, reservado_ahora: result.reservado_ahora });
  } catch (e: any) {
    // p.ej. "No hay contenedores disponibles" -> genera alerta de stock
    if (String(e.message).includes('No hay contenedores')) {
      const [al] = await query(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('stock_bajo', $1, 'Sin contenedores disponibles al validar pago')
         ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING
         RETURNING id, tipo, referencia_id, mensaje, creado_en`,
        [pagoId],
      );
      if (al) emitAlerta(al);
    }
    res.status(409).json({ error: e.message });
  }
});

/** POST /api/pagos/:id/rechazar — marca rechazado y avisa al cliente. */
pagosRouter.post('/:id/rechazar', requireRol('admin', 'operador', 'finanzas'), async (req: Request, res: Response) => {
  const motivo = (req.body?.motivo as string) || 'Comprobante no válido';
  const [pago] = await query<{ cliente_telefono: string; es_cuenta_corriente: boolean; tipo: string }>(
    `UPDATE pagos SET estado = 'rechazado', motivo_rechazo = $2, validado_por = $3
      WHERE id = $1 AND estado = 'pendiente' RETURNING cliente_telefono, es_cuenta_corriente, tipo`,
    [req.params.id, motivo, req.user!.id],
  );
  if (!pago) return res.status(409).json({ error: 'Pago inexistente o ya procesado' });

  // Comparte referencia_id (= pago.id) con la alerta de transferencia, pero
  // es un tipo distinto (ver migración 0013) — hay que resolver la que
  // corresponda según cómo se pidió pagar.
  const tipoAlerta = pago.tipo === 'alargue_retiro'
    ? 'alargue_solicitado'
    : pago.es_cuenta_corriente ? 'cuenta_corriente_solicitada' : 'pago_pendiente_validacion';
  await query(`UPDATE alertas SET estado = 'resuelta'
               WHERE tipo = $2 AND referencia_id = $1`, [req.params.id, tipoAlerta]);
  emitAlertaActualizada({ tipo: tipoAlerta, referencia_id: req.params.id, estado: 'resuelta' });

  sendButtons(
    pago.cliente_telefono,
    `⚠️ Tu comprobante no pudo validarse. Motivo: ${motivo}\n` +
      'Si tenés alguna duda, comunicate con un asesor.',
    [{ id: 'opt_asesor', title: '🙋 Hablar con asesor' }],
  ).catch((e) => console.error('Error avisando rechazo de pago:', motivoErrorWa(e)));

  res.json({ ok: true });
});

/**
 * POST /api/pagos/:id/factura — el operador carga la factura (cuando el
 * cliente la pidió tras el flujo de "Ya pagué") y se la reenviamos por
 * WhatsApp. El archivo viaja en el body crudo (no es un form-data); el
 * frontend manda el File directamente con su Content-Type real. La extensión
 * guardada sale del Content-Type validado contra una whitelist (pdf/jpg/png),
 * nunca de un nombre de archivo dado por el cliente.
 */
pagosRouter.post(
  '/:id/factura',
  requireRol('admin', 'operador', 'finanzas'),
  express.raw({ type: () => true, limit: '10mb' }),
  async (req: Request, res: Response) => {
    const buffer = req.body as Buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Archivo vacío o inválido' });
    }

    const [pago] = await query<{ cliente_telefono: string }>(
      'SELECT cliente_telefono FROM pagos WHERE id = $1',
      [req.params.id],
    );
    if (!pago) return res.status(404).json({ error: 'Pago inexistente' });

    const contentType = req.header('content-type') || 'application/octet-stream';
    // La extensión sale SOLO del Content-Type (whitelist), nunca del filename que
    // manda el cliente: así no se puede colar un archivo con extensión ejecutable/HTML.
    const ext = contentType.includes('pdf')
      ? '.pdf'
      : contentType.includes('png')
        ? '.png'
        : contentType.includes('jpeg') || contentType.includes('jpg')
          ? '.jpg'
          : null;
    if (!ext) return res.status(400).json({ error: 'Tipo de archivo no permitido (solo PDF, JPG o PNG)' });

    const filename = `${req.params.id}_${Date.now()}${ext}`;
    const rutaStorage = `facturas/${filename}`;
    // Cifrado igual que los comprobantes (sección 9): el bucket de terceros
    // nunca guarda el binario en claro. `buffer` sin cifrar se sigue usando
    // abajo para reenviarla por WhatsApp.
    await subirArchivo(encryptBuffer(buffer), rutaStorage, 'application/octet-stream');

    await query('UPDATE pagos SET factura_url = $2 WHERE id = $1', [
      req.params.id,
      encrypt(rutaStorage),
    ]);
    await query(
      `UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'factura_solicitada' AND referencia_id = $1`,
      [req.params.id],
    );
    emitAlertaActualizada({ tipo: 'factura_solicitada', referencia_id: req.params.id, estado: 'resuelta' });

    try {
      const mediaId = await uploadMedia(buffer, contentType, `factura${ext}`);
      await sendDocument(pago.cliente_telefono, mediaId, `factura${ext}`, '🧾 ¡Acá tenés tu factura!');
    } catch (e) {
      const motivo = motivoErrorWa(e);
      console.error('Error enviando factura por WhatsApp:', motivo);
      // Además del 502 al operador que la está cargando ahora, queda una
      // alerta en el panel por si nadie ve esa respuesta (se cerró la
      // pestaña, no se fijó) — que no se pierda que el cliente se quedó sin factura.
      notificarEnvioFallido(req.params.id, pago.cliente_telefono, 'envío de factura', motivo).catch((e2) =>
        console.error('Error registrando alerta de envío fallido:', e2),
      );
      return res.status(502).json({ error: 'La factura se guardó pero no se pudo enviar por WhatsApp' });
    }

    res.json({ ok: true });
  },
);
