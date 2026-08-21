import { PoolClient } from 'pg';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { resolverUbicacion } from '../../services/ubicaciones.service';
import { reservarParaEntrega } from '../../services/contenedorReserva.service';
import { simularDisponibilidad, ParadaSimulada, CapacidadCamion, CAPACIDAD_CAMION_DEFAULT } from './disponibilidad.service';
import { avisarChoferViaje, avisarChoferRecambio } from '../viajes/viajes.routes';
import { motivoErrorWa } from '../whatsapp/graphApi';
import { notificarEnvioFallido } from '../whatsapp/alertaEnvio';

export const rutasRouter = Router();
rutasRouter.use(requireAuth);

/** Estados que cierran la ruta: a partir de acá no se acepta más trabajo. Todo lo demás ('planificada', 'en_curso') está "abierto". */
const ESTADOS_CERRADOS = ['finalizada', 'cancelada'] as const;

function fail(msg: string, status = 409): never {
  const err: any = new Error(msg);
  err.status = status;
  throw err;
}

interface ViajeParada {
  id: string;
  orden: number;
  tipo: 'entrega' | 'retiro';
  contenedor_numero: string | null;
  destino_direccion: string | null;
  zona: string | null;
  cliente_telefono: string | null;
  grupo_id: string | null;
  estado: string;
  notas: string | null;
  ubicacion_id: string | null;
  origen: 'planificada' | 'agregada_en_dia';
  completada_en: string | null;
  ruta_confirmada_en: string | null;
}

interface VaciadoParada {
  id: string;
  orden: number;
  ubicacion_id: string | null;
  ubicacion_nombre: string | null;
  notas: string | null;
}

/**
 * Trae las paradas de una ruta (viajes ∪ ruta_vaciados) y corre
 * `simularDisponibilidad` sobre ellas. `ejecutar` permite reusar esto tanto
 * fuera de una transacción (GET/PATCH, con el helper `query`) como adentro
 * de una (POST /confirmar, con el PoolClient de la propia transacción) —
 * en `confirmar` hace falta leer el snapshot de contenedores disponibles
 * DENTRO de la misma transacción que después los reserva.
 */
async function calcularDisponibilidadRuta(
  rutaId: string,
  ejecutar: (sql: string, params: any[]) => Promise<any[]> = query,
) {
  const viajes: ViajeParada[] = await ejecutar(
    `SELECT id, orden, tipo, contenedor_numero, destino_direccion, zona, cliente_telefono,
            grupo_id, estado, notas, ubicacion_id, origen, completada_en, ruta_confirmada_en
       FROM viajes WHERE ruta_id = $1 ORDER BY orden`,
    [rutaId],
  );
  const vaciados: VaciadoParada[] = await ejecutar(
    `SELECT rv.id, rv.orden, rv.ubicacion_id, u.nombre AS ubicacion_nombre, rv.notas
       FROM ruta_vaciados rv LEFT JOIN ubicaciones u ON u.id = rv.ubicacion_id
      WHERE rv.ruta_id = $1 ORDER BY rv.orden`,
    [rutaId],
  );
  const disponiblesAlInicio: string[] = (
    await ejecutar(
      `SELECT c.numero
         FROM contenedores c
        WHERE c.estado = 'disponible'
          AND c.numero NOT IN (
            SELECT v.contenedor_numero
              FROM viajes v
             WHERE v.contenedor_numero IS NOT NULL
               AND v.ruta_id IS NOT NULL
               AND v.ruta_id <> $1
               AND v.estado IN ('programado', 'en_curso')
          )`,
      [rutaId],
    )
  ).map((r: { numero: string }) => r.numero);

  const capacidadRows: { capacidad_llenos: number; capacidad_vacios: number }[] = await ejecutar(
    `SELECT ch.capacidad_llenos, ch.capacidad_vacios
       FROM rutas r JOIN choferes ch ON ch.id = r.chofer_id
      WHERE r.id = $1`,
    [rutaId],
  );
  const capacidad: CapacidadCamion = capacidadRows[0]
    ? { llenos: capacidadRows[0].capacidad_llenos, vacios: capacidadRows[0].capacidad_vacios }
    : CAPACIDAD_CAMION_DEFAULT;

  const paradasSimuladas: ParadaSimulada[] = [
    ...viajes.map((v) => ({ orden: v.orden, tipoParada: 'viaje' as const, viajeTipo: v.tipo, contenedorNumero: v.contenedor_numero })),
    ...vaciados.map((v) => ({ orden: v.orden, tipoParada: 'vaciado' as const })),
  ];
  const { porOrden, liberadosPor, advertencias } = simularDisponibilidad(paradasSimuladas, disponiblesAlInicio, capacidad);

  return { viajes, vaciados, porOrden, liberadosPor, advertencias };
}

/** Prioridad de tie-break cuando dos paradas comparten `orden` (recambio): entrega antes que retiro. */
function prioridadParada(tipoParada: 'viaje' | 'vaciado', viajeTipo?: string): number {
  if (tipoParada === 'vaciado') return -1;
  return viajeTipo === 'retiro' ? 1 : 0;
}

/**
 * Corre la simulación dentro de la transacción y, mientras haya una parada de
 * retiro/recambio marcada "lleno_sin_vaciar" (más llenos a bordo que la
 * capacidad del camión), inserta automáticamente una parada de vaciado justo
 * después — así el operador no tiene que acordarse de agregarla a mano en
 * cada recambio. Tope de 5 iteraciones: cada inserción resuelve al menos una
 * advertencia, así que en la práctica converge en 1-2 vueltas.
 */
async function resolverVaciadosAutomaticos(c: PoolClient, rutaId: string): Promise<void> {
  const ejecutar = async (sql: string, params: any[]) => (await c.query(sql, params)).rows;
  for (let intento = 0; intento < 5; intento++) {
    const { advertencias } = await calcularDisponibilidadRuta(rutaId, ejecutar);
    const faltante = advertencias.find((a) => a.tipo === 'lleno_sin_vaciar');
    if (!faltante) return;
    await insertarVaciadoAutomatico(c, rutaId, faltante.orden + 1);
  }
}

/** Inserta una parada de vaciado en `orden`, corriendo el resto de la secuencia una posición para atrás. */
async function insertarVaciadoAutomatico(c: PoolClient, rutaId: string, orden: number): Promise<void> {
  // Fase temporal negativa, igual que PATCH /orden, para no chocar contra las
  // constraints UNIQUE de orden mientras se corre la secuencia.
  await c.query(
    `UPDATE viajes SET orden = -(orden + 1) WHERE ruta_id = $1 AND orden >= $2`,
    [rutaId, orden],
  );
  await c.query(
    `UPDATE ruta_vaciados SET orden = -(orden + 1) WHERE ruta_id = $1 AND orden >= $2`,
    [rutaId, orden],
  );
  await c.query(`UPDATE viajes SET orden = -orden WHERE ruta_id = $1 AND orden < 0`, [rutaId]);
  await c.query(`UPDATE ruta_vaciados SET orden = -orden WHERE ruta_id = $1 AND orden < 0`, [rutaId]);

  const ubicacion = await resolverUbicacion('vaciadero');
  await c.query(
    `INSERT INTO ruta_vaciados (ruta_id, orden, ubicacion_id, notas) VALUES ($1,$2,$3,$4)`,
    [rutaId, orden, ubicacion?.id ?? null, 'Vaciado insertado automáticamente (capacidad de llenos del camión).'],
  );
}

const nuevaRutaSchema = z.object({
  fecha: z.string(),
  chofer_id: z.string().uuid(),
  notas: z.string().optional(),
});

/** GET /api/rutas?fecha=&chofer_id=&estado= */
rutasRouter.get('/', async (req: Request, res: Response) => {
  const { fecha, chofer_id: choferId, estado } = req.query as Record<string, string>;
  const conds: string[] = [];
  const params: any[] = [];
  if (fecha) { params.push(fecha); conds.push(`r.fecha = $${params.length}`); }
  if (choferId) { params.push(choferId); conds.push(`r.chofer_id = $${params.length}`); }
  if (estado) { params.push(estado); conds.push(`r.estado = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await query(
    `SELECT r.id, r.fecha, r.chofer_id, c.nombre AS chofer_nombre, r.patente, r.estado, r.notas, r.version, r.creado_en
       FROM rutas r LEFT JOIN choferes c ON c.id = r.chofer_id
       ${where}
       ORDER BY r.fecha DESC, r.creado_en DESC`,
    params,
  );
  res.json(rows);
});

/** POST /api/rutas — crea el "cascarón" de una ruta (admin/operador). */
rutasRouter.post('/', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = nuevaRutaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { fecha, chofer_id, notas } = parsed.data;

  const [chofer] = await query<{ patente: string | null }>('SELECT patente FROM choferes WHERE id = $1', [chofer_id]);
  if (!chofer) return res.status(400).json({ error: 'Chofer inválido.' });

  try {
    const [ruta] = await query(
      `INSERT INTO rutas (fecha, chofer_id, patente, armada_por, notas)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [fecha, chofer_id, chofer.patente, req.user!.id, notas ?? null],
    );
    res.status(201).json(ruta);
  } catch (error: any) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'Ya existe una ruta planificada para este chofer en esta fecha.' });
    } else {
      throw error;
    }
  }
});

/**
 * GET /api/rutas/bolsa?fecha= — viajes sin rutear (la bolsa de pendientes),
 * listos para que el frontend los agrupe por zona y los arrastre a una ruta.
 * `planificable`: una entrega (horario pedido / vencimiento) se puede mover
 * de fecha u orden con libertad; un recambio (la mitad "retiro" trae un
 * contenedor YA posicionado en lo del cliente) no — solo se rutea, no se
 * replanifica.
 */
rutasRouter.get('/bolsa', async (req: Request, res: Response) => {
  const { fecha } = req.query as Record<string, string>;
  const conds = [`v.ruta_id IS NULL`, `v.estado IN ('programado', 'en_curso')`];
  const params: any[] = [];
  if (fecha) { params.push(fecha); conds.push(`v.fecha = $${params.length}`); }
  const rows = await query(
    `SELECT v.id, v.tipo, v.fecha, v.zona, v.contenedor_numero, v.destino_direccion,
            v.cliente_telefono, v.grupo_id, v.notas, v.creado_en,
            (v.tipo = 'entrega') AS planificable
       FROM viajes v
      WHERE ${conds.join(' AND ')}
      ORDER BY v.zona NULLS LAST, v.fecha, v.creado_en`,
    params,
  );
  res.json(rows);
});

/** GET /api/rutas/:id — ruta + paradas ordenadas + disponibilidad resuelta por parada de entrega. */
rutasRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const [ruta] = await query(
    `SELECT r.id, r.fecha, r.chofer_id, c.nombre AS chofer_nombre, r.patente, r.estado, r.notas, r.version, r.creado_en
       FROM rutas r LEFT JOIN choferes c ON c.id = r.chofer_id WHERE r.id = $1`,
    [id],
  );
  if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada.' });

  const { viajes, vaciados, porOrden, advertencias } = await calcularDisponibilidadRuta(id);

  const paradas = [
    ...viajes.map((v) => ({
      tipo_parada: 'viaje' as const,
      id: v.id,
      orden: v.orden,
      viaje_tipo: v.tipo,
      contenedor_numero: v.contenedor_numero,
      destino_direccion: v.destino_direccion,
      zona: v.zona,
      cliente_telefono: v.cliente_telefono,
      grupo_id: v.grupo_id,
      estado: v.estado,
      notas: v.notas,
      origen: v.origen,
      completada_en: v.completada_en,
      // Solo tiene sentido ofrecer opciones en la mitad "entrega": la mitad
      // "retiro" siempre trae su propio contenedor (el lleno del cliente).
      disponibles: v.tipo === 'entrega' ? (porOrden.get(v.orden) ?? []) : undefined,
    })),
    ...vaciados.map((v) => ({
      tipo_parada: 'vaciado' as const,
      id: v.id,
      orden: v.orden,
      ubicacion_id: v.ubicacion_id,
      ubicacion_nombre: v.ubicacion_nombre,
      notas: v.notas,
    })),
  ].sort((a, b) => {
    if (a.orden !== b.orden) return a.orden - b.orden;
    return prioridadParada(a.tipo_parada, (a as any).viaje_tipo) - prioridadParada(b.tipo_parada, (b as any).viaje_tipo);
  });

  res.json({ ...ruta, paradas, advertencias });
});

const nuevaParadaSchema = z.object({ viaje_id: z.string().uuid() });

/** POST /api/rutas/:id/paradas — adjunta un viaje YA EXISTENTE (de la cola sin rutear) a la ruta. Funciona con la ruta abierta (planificada o en curso): el 80% del trabajo entra durante el día. */
rutasRouter.post('/:id/paradas', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId } = req.params;
  const parsed = nuevaParadaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { viaje_id } = parsed.data;

  try {
    const resultado = await withTx(async (c) => {
      const { rows: rutaRows } = await c.query<{ chofer_id: string; fecha: string; patente: string | null; estado: string }>(
        'SELECT chofer_id, fecha, patente, estado FROM rutas WHERE id = $1 FOR UPDATE',
        [rutaId],
      );
      const ruta = rutaRows[0];
      if (!ruta) fail('Ruta no encontrada.', 404);
      if (ESTADOS_CERRADOS.includes(ruta!.estado as any)) fail('Esta ruta ya está cerrada; no se le puede agregar más trabajo.');

      const origen = ruta!.estado === 'en_curso' ? 'agregada_en_dia' : 'planificada';

      const { rows: ordenRows } = await c.query<{ max: number | null }>(
        `SELECT MAX(orden) AS max FROM (
           SELECT orden FROM viajes WHERE ruta_id = $1
           UNION ALL SELECT orden FROM ruta_vaciados WHERE ruta_id = $1
         ) t`,
        [rutaId],
      );
      const nuevoOrden = (ordenRows[0]?.max ?? 0) + 1;

      const { rows: viajeRows } = await c.query<{ id: string; grupo_id: string | null; tipo: string }>(
        `UPDATE viajes SET ruta_id = $1, orden = $2, chofer_id = $3, patente = $4, fecha = $5, origen = $6
           WHERE id = $7 AND ruta_id IS NULL
           RETURNING id, grupo_id, tipo`,
        [rutaId, nuevoOrden, ruta!.chofer_id, ruta!.patente, ruta!.fecha, origen, viaje_id],
      );
      const viaje = viajeRows[0];
      if (!viaje) fail('Ese viaje no existe o ya está en una ruta.');

      // Recambio: la pareja (mismo grupo_id) va a la misma visita física.
      if (viaje!.grupo_id) {
        await c.query(
          `UPDATE viajes SET ruta_id = $1, orden = $2, chofer_id = $3, patente = $4, fecha = $5, origen = $6
             WHERE grupo_id = $7 AND id <> $8 AND ruta_id IS NULL`,
          [rutaId, nuevoOrden, ruta!.chofer_id, ruta!.patente, ruta!.fecha, origen, viaje!.grupo_id, viaje!.id],
        );
      }

      if (viaje!.tipo === 'retiro') {
        await resolverVaciadosAutomaticos(c, rutaId);
      }

      return { orden: nuevoOrden };
    });
    res.status(201).json(resultado);
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

const nuevoVaciadoSchema = z.object({
  ubicacion_id: z.string().uuid().optional(),
  notas: z.string().optional(),
});

/** POST /api/rutas/:id/paradas/vaciado — agrega una parada de vaciado (sin pedido asociado). */
rutasRouter.post('/:id/paradas/vaciado', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId } = req.params;
  const parsed = nuevoVaciadoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { ubicacion_id, notas } = parsed.data;

  const ubicacion = await resolverUbicacion('vaciadero', ubicacion_id);
  if (ubicacion_id && !ubicacion) {
    return res.status(400).json({ error: 'Ubicación inválida (tiene que ser un vaciadero activo).' });
  }
  if (!ubicacion_id && !ubicacion) {
    const activas = await query<{ id: string }>(`SELECT id FROM ubicaciones WHERE tipo = 'vaciadero' AND activo = TRUE`);
    if (activas.length > 1) return res.status(400).json({ error: 'Elegí un vaciadero: hay más de uno cargado.' });
    // 0 activas: se deja sin ubicación (todavía no se cargó ninguna en /ubicaciones).
  }

  try {
    const resultado = await withTx(async (c) => {
      const { rows: rutaRows } = await c.query<{ estado: string }>('SELECT estado FROM rutas WHERE id = $1 FOR UPDATE', [rutaId]);
      if (!rutaRows[0]) fail('Ruta no encontrada.', 404);
      if (ESTADOS_CERRADOS.includes(rutaRows[0]!.estado as any)) fail('Esta ruta ya está cerrada; no se le puede agregar más trabajo.');

      const { rows: ordenRows } = await c.query<{ max: number | null }>(
        `SELECT MAX(orden) AS max FROM (
           SELECT orden FROM viajes WHERE ruta_id = $1
           UNION ALL SELECT orden FROM ruta_vaciados WHERE ruta_id = $1
         ) t`,
        [rutaId],
      );
      const nuevoOrden = (ordenRows[0]?.max ?? 0) + 1;

      const { rows } = await c.query(
        `INSERT INTO ruta_vaciados (ruta_id, orden, ubicacion_id, notas) VALUES ($1,$2,$3,$4) RETURNING *`,
        [rutaId, nuevoOrden, ubicacion?.id ?? null, notas ?? null],
      );
      return rows[0];
    });
    res.status(201).json(resultado);
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

/** DELETE /api/rutas/:id/paradas/:tipo/:paradaId — desprende una parada, vuelve a la cola. */
rutasRouter.delete('/:id/paradas/:tipo/:paradaId', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId, tipo, paradaId } = req.params;
  if (tipo !== 'viaje' && tipo !== 'vaciado') return res.status(400).json({ error: 'Tipo de parada inválido.' });

  if (tipo === 'vaciado') {
    const rows = await query(`DELETE FROM ruta_vaciados WHERE id = $1 AND ruta_id = $2 RETURNING id`, [paradaId, rutaId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Parada no encontrada.' });
    return res.json({ ok: true });
  }

  const rows = await query<{ id: string; grupo_id: string | null }>(
    `UPDATE viajes SET ruta_id = NULL, orden = NULL, chofer_id = NULL, patente = NULL
       WHERE id = $1 AND ruta_id = $2 RETURNING id, grupo_id`,
    [paradaId, rutaId],
  );
  const viaje = rows[0];
  if (!viaje) return res.status(404).json({ error: 'Parada no encontrada.' });
  if (viaje.grupo_id) {
    await query(
      `UPDATE viajes SET ruta_id = NULL, orden = NULL, chofer_id = NULL, patente = NULL
         WHERE grupo_id = $1 AND id <> $2 AND ruta_id = $3`,
      [viaje.grupo_id, viaje.id, rutaId],
    );
  }
  res.json({ ok: true });
});

const moverParadaSchema = z.object({ ruta_destino_id: z.string().uuid() });

/**
 * POST /api/rutas/:id/paradas/:tipo/:paradaId/mover — mueve una parada
 * directo a otra ruta (a diferencia de DELETE, que la desprende a la cola en
 * dos pasos). Caso de uso: se rompe un camión o falta un chofer y hay que
 * repartir sus paradas entre otros camiones ya en curso.
 */
rutasRouter.post('/:id/paradas/:tipo/:paradaId/mover', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaOrigenId, tipo, paradaId } = req.params;
  if (tipo !== 'viaje' && tipo !== 'vaciado') return res.status(400).json({ error: 'Tipo de parada inválido.' });
  const parsed = moverParadaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { ruta_destino_id: rutaDestinoId } = parsed.data;
  if (rutaDestinoId === rutaOrigenId) return res.status(400).json({ error: 'La ruta de destino tiene que ser distinta de la de origen.' });

  try {
    const resultado = await withTx(async (c) => {
      const { rows: destRows } = await c.query<{ chofer_id: string; patente: string | null; fecha: string; estado: string }>(
        'SELECT chofer_id, patente, fecha, estado FROM rutas WHERE id = $1 FOR UPDATE',
        [rutaDestinoId],
      );
      const destino = destRows[0];
      if (!destino) fail('Ruta de destino no encontrada.', 404);
      if (ESTADOS_CERRADOS.includes(destino!.estado as any)) fail('La ruta de destino ya está cerrada.');

      const { rows: ordenRows } = await c.query<{ max: number | null }>(
        `SELECT MAX(orden) AS max FROM (
           SELECT orden FROM viajes WHERE ruta_id = $1
           UNION ALL SELECT orden FROM ruta_vaciados WHERE ruta_id = $1
         ) t`,
        [rutaDestinoId],
      );
      const nuevoOrden = (ordenRows[0]?.max ?? 0) + 1;
      const origen = destino!.estado === 'en_curso' ? 'agregada_en_dia' : 'planificada';
      const ejecutar = async (sql: string, params: any[]) => (await c.query(sql, params)).rows;

      if (tipo === 'vaciado') {
        const { rows } = await c.query(
          `UPDATE ruta_vaciados SET ruta_id = $1, orden = $2 WHERE id = $3 AND ruta_id = $4 RETURNING id`,
          [rutaDestinoId, nuevoOrden, paradaId, rutaOrigenId],
        );
        if (!rows[0]) fail('Parada no encontrada en la ruta de origen.', 404);
        const { advertencias } = await calcularDisponibilidadRuta(rutaDestinoId, ejecutar);
        return { orden: nuevoOrden, advertencias };
      }

      const { rows: viajeRows } = await c.query<{ id: string; grupo_id: string | null; tipo: string }>(
        `UPDATE viajes SET ruta_id = $1, orden = $2, chofer_id = $3, patente = $4, fecha = $5, origen = $6
           WHERE id = $7 AND ruta_id = $8
           RETURNING id, grupo_id, tipo`,
        [rutaDestinoId, nuevoOrden, destino!.chofer_id, destino!.patente, destino!.fecha, origen, paradaId, rutaOrigenId],
      );
      const viaje = viajeRows[0];
      if (!viaje) fail('Parada no encontrada en la ruta de origen.', 404);
      if (viaje!.grupo_id) {
        await c.query(
          `UPDATE viajes SET ruta_id = $1, orden = $2, chofer_id = $3, patente = $4, fecha = $5, origen = $6
             WHERE grupo_id = $7 AND id <> $8 AND ruta_id = $9`,
          [rutaDestinoId, nuevoOrden, destino!.chofer_id, destino!.patente, destino!.fecha, origen, viaje!.grupo_id, viaje!.id, rutaOrigenId],
        );
      }

      if (viaje!.tipo === 'retiro') {
        await resolverVaciadosAutomaticos(c, rutaDestinoId);
      }

      const { advertencias } = await calcularDisponibilidadRuta(rutaDestinoId, ejecutar);
      return { orden: nuevoOrden, advertencias };
    });
    res.status(200).json(resultado);
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

const ordenSchema = z.object({
  secuencia: z.array(z.object({ tipo: z.enum(['viaje', 'vaciado']), id: z.string().uuid() })).min(1),
  // Lock optimista: el frontend manda la `version` que tenía cuando cargó la
  // ruta. Si no coincide con la actual, alguien más la modificó mientras
  // tanto — se rechaza en vez de pisarle el trabajo.
  version: z.number().int().optional(),
});

/**
 * PATCH /api/rutas/:id/orden — reescribe toda la secuencia (no "mover uno").
 * Dos fases (temporal negativo -> final positivo) para no chocar contra las
 * constraints UNIQUE de orden mientras se reordena dentro de la transacción.
 */
rutasRouter.patch('/:id/orden', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId } = req.params;
  const parsed = ordenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { secuencia, version } = parsed.data;

  try {
    const resultado = await withTx(async (c) => {
      const { rows: rutaRows } = await c.query<{ estado: string; version: number }>(
        'SELECT estado, version FROM rutas WHERE id = $1 FOR UPDATE',
        [rutaId],
      );
      const ruta = rutaRows[0];
      if (!ruta) fail('Ruta no encontrada.', 404);
      if (ESTADOS_CERRADOS.includes(ruta!.estado as any)) fail('Esta ruta ya está cerrada; no se puede reordenar.');
      if (version !== undefined && version !== ruta!.version) {
        fail('Alguien más modificó esta ruta mientras tanto. Recargá para ver los cambios y volvé a intentar.');
      }

      for (let i = 0; i < secuencia.length; i++) {
        const p = secuencia[i];
        const tmp = -(i + 1);
        if (p.tipo === 'viaje') {
          await c.query(`UPDATE viajes SET orden = $1 WHERE id = $2 AND ruta_id = $3`, [tmp, p.id, rutaId]);
        } else {
          await c.query(`UPDATE ruta_vaciados SET orden = $1 WHERE id = $2 AND ruta_id = $3`, [tmp, p.id, rutaId]);
        }
      }
      for (let i = 0; i < secuencia.length; i++) {
        const p = secuencia[i];
        const nuevoOrden = i + 1;
        if (p.tipo === 'viaje') {
          const { rows } = await c.query<{ grupo_id: string | null }>(
            `UPDATE viajes SET orden = $1 WHERE id = $2 AND ruta_id = $3 RETURNING grupo_id`,
            [nuevoOrden, p.id, rutaId],
          );
          if (rows[0]?.grupo_id) {
            await c.query(`UPDATE viajes SET orden = $1 WHERE grupo_id = $2 AND ruta_id = $3`, [nuevoOrden, rows[0].grupo_id, rutaId]);
          }
        } else {
          await c.query(`UPDATE ruta_vaciados SET orden = $1 WHERE id = $2 AND ruta_id = $3`, [nuevoOrden, p.id, rutaId]);
        }
      }

      await resolverVaciadosAutomaticos(c, rutaId);

      const { rows: versionRows } = await c.query<{ version: number }>(
        `UPDATE rutas SET version = version + 1 WHERE id = $1 RETURNING version`,
        [rutaId],
      );
      const { advertencias } = await calcularDisponibilidadRuta(rutaId, async (sql, params) => (await c.query(sql, params)).rows);
      return { version: versionRows[0].version, advertencias };
    });
    res.json({ ok: true, ...resultado });
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

const contenedorParadaSchema = z.object({ contenedor_numero: z.string().min(1) });

/** PATCH /api/rutas/:id/paradas/:viajeId/contenedor — asigna contenedor validado contra la disponibilidad simulada. */
rutasRouter.patch('/:id/paradas/:viajeId/contenedor', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId, viajeId } = req.params;
  const parsed = contenedorParadaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { contenedor_numero } = parsed.data;

  const [viaje] = await query<{ orden: number | null; tipo: string }>(
    `SELECT orden, tipo FROM viajes WHERE id = $1 AND ruta_id = $2`,
    [viajeId, rutaId],
  );
  if (!viaje) return res.status(404).json({ error: 'Parada no encontrada en esta ruta.' });
  if (viaje.tipo !== 'entrega') return res.status(400).json({ error: 'Solo se asigna contenedor en una parada de entrega.' });

  const { porOrden } = await calcularDisponibilidadRuta(rutaId);
  const disponibles = porOrden.get(viaje.orden!) ?? [];
  if (!disponibles.includes(contenedor_numero)) {
    return res.status(409).json({ error: `El contenedor ${contenedor_numero} no está disponible en esta parada.` });
  }

  await query(`UPDATE viajes SET contenedor_numero = $1 WHERE id = $2`, [contenedor_numero, viajeId]);
  res.json({ ok: true });
});

/**
 * POST /api/rutas/:id/confirmar — revalida con datos frescos y reserva.
 *
 * NO es todo-o-nada ni cierra la ruta: reserva cada parada de entrega que ya
 * es válida y confirmable, deja pendientes las que no (sin abortar el resto),
 * y es idempotente/reintentable — una parada ya confirmada en una corrida
 * anterior (`ruta_confirmada_en`) no se vuelve a reservar ni a avisar. Así
 * soporta confirmaciones repetidas durante el día a medida que entra trabajo
 * nuevo, sin que una sola parada todavía sin contenedor haga fallar la tanda
 * entera.
 */
rutasRouter.post('/:id/confirmar', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId } = req.params;
  const actualizadoPor = `operador:${req.user!.id}`;

  try {
    const resultado = await withTx(async (c) => {
      const ejecutar = async (sql: string, params: any[]) => (await c.query(sql, params)).rows;

      const { rows: rutaRows } = await c.query<{ fecha: string; chofer_id: string; estado: string }>(
        'SELECT fecha, chofer_id, estado FROM rutas WHERE id = $1 FOR UPDATE',
        [rutaId],
      );
      const ruta = rutaRows[0];
      if (!ruta) fail('Ruta no encontrada.', 404);
      if (ESTADOS_CERRADOS.includes(ruta!.estado as any)) fail('Esta ruta ya está cerrada.');

      const { viajes, porOrden, liberadosPor } = await calcularDisponibilidadRuta(rutaId, ejecutar);
      if (viajes.length === 0) fail('La ruta no tiene ninguna parada.');

      const pendientes: string[] = [];
      const confirmadasAhora: ViajeParada[] = [];

      const entregas = viajes.filter((v) => v.tipo === 'entrega');
      for (const v of entregas) {
        if (v.ruta_confirmada_en) continue; // ya reservada/avisada en una corrida anterior
        try {
          if (!v.contenedor_numero) {
            pendientes.push(`La parada ${v.orden} (entrega) no tiene contenedor asignado todavía.`);
            continue;
          }
          const disponibles = porOrden.get(v.orden) ?? [];
          if (!disponibles.includes(v.contenedor_numero)) {
            pendientes.push(`El contenedor ${v.contenedor_numero} de la parada ${v.orden} ya no está disponible — otro proceso lo tomó mientras se armaba la ruta.`);
            continue;
          }
          const liberadoEn = liberadosPor.get(v.contenedor_numero);
          await reservarParaEntrega(c, v.contenedor_numero, ruta!.fecha, actualizadoPor, {
            excluirViajeId: v.id,
            ...(liberadoEn !== undefined ? { liberadoPorRutaEnOrden: liberadoEn } : {}),
          });
          await c.query(`UPDATE viajes SET ruta_confirmada_en = now() WHERE id = $1`, [v.id]);
          confirmadasAhora.push(v);
        } catch (err: any) {
          pendientes.push(err.message ?? `No se pudo confirmar la parada ${v.orden}.`);
        }
      }

      // Los retiros (incl. la mitad-retiro de un recambio) no reservan
      // contenedor — el lleno ya está en lo del cliente — pero sí hace falta
      // marcarlos confirmados para no volver a avisarle al chofer en la
      // próxima corrida de `confirmar`.
      const retiros = viajes.filter((v) => v.tipo === 'retiro' && !v.ruta_confirmada_en);
      for (const v of retiros) {
        await c.query(`UPDATE viajes SET ruta_confirmada_en = now() WHERE id = $1`, [v.id]);
        confirmadasAhora.push(v);
      }

      // Primera confirmación: la ruta pasa a "en curso" (abierta, sigue
      // aceptando trabajo nuevo). Confirmaciones siguientes durante el día no
      // tocan el estado — ya está donde tiene que estar.
      if (ruta!.estado === 'planificada') {
        await c.query(`UPDATE rutas SET estado = 'en_curso' WHERE id = $1`, [rutaId]);
      }

      return { confirmadasAhora, choferId: ruta!.chofer_id, pendientes };
    });

    // Avisos por WhatsApp fuera de la transacción (no bloqueantes), uno por
    // VISITA (agrupando por `orden`: un recambio manda un solo aviso, no dos)
    // — y solo para lo confirmado EN ESTA CORRIDA, no lo ya avisado antes.
    const porOrdenVisita = new Map<number, ViajeParada[]>();
    for (const v of resultado.confirmadasAhora) {
      const lista = porOrdenVisita.get(v.orden) ?? [];
      lista.push(v);
      porOrdenVisita.set(v.orden, lista);
    }
    for (const visita of porOrdenVisita.values()) {
      const entrega = visita.find((v) => v.tipo === 'entrega');
      const retiro = visita.find((v) => v.tipo === 'retiro');
      let aviso: Promise<void>;
      let referenciaId: string;
      if (entrega?.grupo_id && retiro) {
        // Recambio: un solo aviso consolidado (mismo criterio que POST /api/viajes).
        aviso = avisarChoferRecambio(resultado.choferId, retiro.contenedor_numero!, entrega.contenedor_numero, entrega.ubicacion_id, entrega.destino_direccion);
        referenciaId = retiro.id;
      } else {
        const v = entrega ?? retiro!;
        aviso = avisarChoferViaje(resultado.choferId, v.tipo, v.contenedor_numero, v.destino_direccion);
        referenciaId = v.id;
      }
      aviso.catch((e: any) => {
        const motivo = motivoErrorWa(e);
        console.error('Error avisando al chofer la ruta confirmada:', motivo);
        notificarEnvioFallido(referenciaId, `chofer de la ruta ${rutaId}`, 'aviso de ruta confirmada', motivo).catch(
          (e2) => console.error('Error registrando alerta de envío fallido:', e2),
        );
      });
    }

    res.json({ ok: true, confirmadas: resultado.confirmadasAhora.length, pendientes: resultado.pendientes });
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

const estadoRutaSchema = z.object({ estado: z.enum(['planificada', 'en_curso', 'finalizada', 'cancelada']) });

/** PATCH /api/rutas/:id — transición manual de estado (v1 no tiene ningún disparador automático). */
rutasRouter.patch('/:id', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const parsed = estadoRutaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const [ruta] = await query(`UPDATE rutas SET estado = $1 WHERE id = $2 RETURNING *`, [parsed.data.estado, req.params.id]);
  if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada.' });
  res.json(ruta);
});

/** DELETE /api/rutas/:id — solo si sigue planificada y ninguna parada avanzó. */
rutasRouter.delete('/:id', requireRol('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const [ruta] = await query<{ estado: string }>('SELECT estado FROM rutas WHERE id = $1', [id]);
  if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada.' });
  if (ruta.estado !== 'planificada') {
    return res.status(409).json({ error: 'Solo se puede borrar una ruta planificada.' });
  }
  const [avanzada] = await query(
    `SELECT id FROM viajes WHERE ruta_id = $1 AND estado <> 'programado' LIMIT 1`,
    [id],
  );
  if (avanzada) return res.status(409).json({ error: 'Esta ruta ya tiene paradas en curso o completadas; no se puede borrar.' });

  await query(`UPDATE viajes SET ruta_id = NULL, orden = NULL, chofer_id = NULL, patente = NULL WHERE ruta_id = $1`, [id]);
  await query(`DELETE FROM ruta_vaciados WHERE ruta_id = $1`, [id]);
  await query(`DELETE FROM rutas WHERE id = $1`, [id]);
  res.json({ ok: true });
});
