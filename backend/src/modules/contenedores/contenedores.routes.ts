import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { finalizarRetiro } from '../../services/retiro.service';

export const contenedoresRouter = Router();
contenedoresRouter.use(requireAuth);

/**
 * GET /api/contenedores — Listar todos los contenedores.
 * `actualizado_por` se guarda como "chofer:<uuid>"/"operador:<uuid>" (para
 * poder resolverlo bien acá) — sin este JOIN se mostraba el uuid crudo en el
 * panel y parecía un valor cifrado/ilegible.
 */
contenedoresRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT c.numero, c.estado, c.cliente_id, c.vence_en, c.actualizado_en, c.creado_en,
            -- Vista "por contrato" (Disponible/Alquilado/Para retirar/Yendo a
            -- vaciar/Vencido) derivada del estado técnico, sin tocarlo —
            -- misma expresión duplicada en viajes.routes.ts (columna
            -- contenedor_estado); mantener ambas en sync.
            CASE
              WHEN EXISTS (
                SELECT 1 FROM viajes v
                 WHERE v.contenedor_numero = c.numero AND v.tipo = 'retiro' AND v.estado = 'en_curso'
              ) THEN 'yendo_a_vaciar'
              WHEN EXISTS (
                SELECT 1 FROM viajes v
                 WHERE v.contenedor_numero = c.numero AND v.tipo = 'retiro' AND v.estado = 'programado'
              ) THEN 'para_retirar'
              WHEN c.estado = 'entregado' AND c.vence_en IS NOT NULL AND c.vence_en < now() THEN 'vencido'
              WHEN c.estado = 'entregado' THEN 'alquilado'
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
            va.cliente_telefono, va.destino_direccion,
            COALESCE(cl.nombre, va.cliente_telefono) AS cliente_nombre
       FROM contenedores c
       LEFT JOIN choferes ch ON c.actualizado_por LIKE 'chofer:%' AND ch.id::text = substring(c.actualizado_por FROM 8)
       LEFT JOIN usuarios u  ON c.actualizado_por LIKE 'operador:%' AND u.id::text = substring(c.actualizado_por FROM 10)
       -- Viaje activo (entrega o retiro) que tiene hoy asignado este contenedor,
       -- para que el operador vea de un vistazo si quedó "huérfano" sin chofer,
       -- y de quién/adónde es la entrega en curso.
       LEFT JOIN LATERAL (
         SELECT v.tipo, v.chofer_id, v.cliente_telefono, v.destino_direccion
           FROM viajes v
          WHERE v.contenedor_numero = c.numero AND v.estado IN ('programado', 'en_curso')
          ORDER BY v.creado_en DESC LIMIT 1
       ) va ON true
       LEFT JOIN choferes vch ON vch.id = va.chofer_id
       LEFT JOIN clientes cl ON cl.telefono = va.cliente_telefono
      ORDER BY c.actualizado_en DESC`,
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

/** POST /api/contenedores — Crear un contenedor (solo admin/operador). */
contenedoresRouter.post('/', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = nuevoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  
  const { numero } = parsed.data;
  // Convertir a mayúsculas para mantener consistencia, aunque no esté forzado a MSKU
  const numeroNormalizado = numero.trim().toUpperCase();

  try {
    const [row] = await query(
      `INSERT INTO contenedores (numero) VALUES ($1) RETURNING *`,
      [numeroNormalizado]
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
