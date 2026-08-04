import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { sendText } from '../whatsapp/graphApi';

export const contenedoresRouter = Router();
contenedoresRouter.use(requireAuth);

/** GET /api/contenedores — Listar todos los contenedores. */
contenedoresRouter.get('/', async (req: Request, res: Response) => {
  const rows = await query(
    'SELECT numero, estado, cliente_id, vence_en, actualizado_por, actualizado_en, creado_en FROM contenedores ORDER BY actualizado_en DESC'
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
 * de estado (antes queda pendiente, ver flows/chofer.flow.ts) y se avisa
 * al chofer.
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
      // El trigger fn_validar_transicion_contenedor exige que venga de "entregado".
      await query(
        `UPDATE contenedores SET estado = 'retirado', actualizado_por = $2 WHERE numero = $1`,
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
    await query(
      `UPDATE alertas SET estado = 'resuelta' WHERE tipo = 'confirmar_retiro' AND referencia_id = $1`,
      [numero],
    );

    if (viaje.chofer_id) {
      const [chofer] = await query<{ telefono: string }>('SELECT telefono FROM choferes WHERE id = $1', [viaje.chofer_id]);
      if (chofer) {
        sendText(
          chofer.telefono,
          `✅ Confirmado: el contenedor *${numero}* ya quedó registrado en la empresa. ¡Gracias por tu trabajo! 🙌`,
        ).catch((e) => console.error('Error avisando al chofer:', e));
      }
    }

    res.json({ ok: true });
  },
);
