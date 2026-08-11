import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendText, motivoErrorWa } from '../whatsapp/graphApi';
import { emitAlertaActualizada, emitRecursoActualizado } from '../../config/socket';

export const contenedoresRouter = Router();
contenedoresRouter.use(requireAuth);

/**
 * GET /api/contenedores — Listar todos los contenedores.
 * `actualizado_por` se guarda como "chofer:<uuid>"/"operador:<uuid>" (para
 * poder resolverlo bien acá) — sin este JOIN se mostraba el uuid crudo en el
 * panel y parecía un valor cifrado/ilegible.
 */
contenedoresRouter.get('/', async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT c.numero, c.estado, c.cliente_id, c.vence_en, c.actualizado_en, c.creado_en,
            CASE
              WHEN c.actualizado_por LIKE 'chofer:%'   THEN COALESCE(ch.nombre, 'Chofer eliminado')
              WHEN c.actualizado_por LIKE 'operador:%' THEN COALESCE(u.nombre, 'Usuario eliminado')
              WHEN c.actualizado_por = 'validacion_pago' THEN 'Sistema (validación de pago)'
              ELSE c.actualizado_por
            END AS actualizado_por
       FROM contenedores c
       LEFT JOIN choferes ch ON c.actualizado_por LIKE 'chofer:%' AND ch.id::text = substring(c.actualizado_por FROM 8)
       LEFT JOIN usuarios u  ON c.actualizado_por LIKE 'operador:%' AND u.id::text = substring(c.actualizado_por FROM 10)
      ORDER BY c.actualizado_en DESC`,
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
 * POST /api/contenedores/:numero/confirmar-retiro — el operador confirma
 * desde el panel que el contenedor que un chofer marcó como "retirado" por
 * WhatsApp llegó físicamente a la empresa. Recién ahí se aplica el cambio
 * de estado (antes queda pendiente, ver flows/chofer.flow.ts), vuelve a
 * quedar disponible para un cliente nuevo, y se avisa al chofer.
 */
contenedoresRouter.post(
  '/:numero/confirmar-retiro',
  requireRol('admin', 'operador'),
  async (req: Request, res: Response) => {
    const numero = req.params.numero;

    const [viaje] = await query<{ id: string; chofer_id: string | null }>(
      `SELECT id, chofer_id FROM viajes
        WHERE contenedor_numero = $1 AND tipo = 'retiro' AND estado = 'en_curso'
        ORDER BY creado_en DESC LIMIT 1`,
      [numero],
    );
    if (!viaje) {
      return res.status(404).json({ error: 'No hay un retiro pendiente de confirmación para ese contenedor' });
    }

    try {
      // El trigger fn_validar_transicion_contenedor solo permite "entregado" ->
      // "retirado" directo; de ahí sí puede pasar a "disponible" (dos updates,
      // cada uno válido por separado para el trigger). Vacía vence_en (era la
      // fecha límite del cliente anterior, ya no aplica) para que el cron de
      // "contenedor por vencer" no dispare una alerta vieja por error.
      await query(
        `UPDATE contenedores SET estado = 'retirado', actualizado_por = $2 WHERE numero = $1`,
        [numero, `operador:${req.user!.id}`],
      );
      await query(
        `UPDATE contenedores SET estado = 'disponible', vence_en = NULL, cliente_id = NULL, actualizado_por = $2 WHERE numero = $1`,
        [numero, `operador:${req.user!.id}`],
      );
    } catch (e: any) {
      return res.status(409).json({ error: e.message });
    }

    await query(
      `INSERT INTO historial_contenedores (numero_contenedor, estado, chofer_id, nota)
       VALUES ($1, 'retirado', $2, 'confirmado por operador vía panel')`,
      [numero, viaje.chofer_id],
    );
    await query(`UPDATE viajes SET estado = 'completado' WHERE id = $1`, [viaje.id]);
    if (viaje.chofer_id) {
      // El viaje de "entrega" (creado al validar el pago o al programarlo a
      // mano) recién se cierra acá, cuando termina el ciclo completo — si se
      // completaba antes (al marcar "entregado"), el chofer dejaba de tener
      // un viaje activo vinculado y el filtro de seguridad de
      // elegirContenedor (solo contenedores de SU propio viaje activo) le
      // ocultaba el contenedor a la hora de elegir "ya retiré".
      await query(
        `UPDATE viajes SET estado = 'completado'
          WHERE contenedor_numero = $1 AND chofer_id = $2 AND tipo = 'entrega' AND estado IN ('programado', 'en_curso')`,
        [numero, viaje.chofer_id],
      );
    }
    await query(
      `UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'confirmar_retiro' AND referencia_id = $1`,
      [numero],
    );
    emitAlertaActualizada({ tipo: 'confirmar_retiro', referencia_id: numero, estado: 'resuelta' });
    // Redundante con broadcastCambios (que ya debería cubrir esta ruta), pero
    // explícito acá para no depender de esa cobertura genérica: la pestaña
    // Contenedores tiene que verse "disponible" sin que nadie tenga que
    // refrescar la página.
    emitRecursoActualizado('contenedores');

    if (viaje.chofer_id) {
      const [chofer] = await query<{ telefono: string }>('SELECT telefono FROM choferes WHERE id = $1', [viaje.chofer_id]);
      if (chofer) {
        sendText(
          chofer.telefono,
          `✅ Confirmado: el contenedor *${numero}* ya quedó registrado en la empresa. ¡Gracias por tu trabajo! 🙌`,
        ).catch((e) => console.error('Error avisando al chofer:', motivoErrorWa(e)));
      }
    }

    res.json({ ok: true });
  },
);
