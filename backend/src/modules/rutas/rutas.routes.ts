import { PoolClient } from 'pg';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../config/db';
import { requireAuth, requireRol } from '../../middleware/rbac';
import { resolverUbicacion } from '../../services/ubicaciones.service';
import { reservarParaEntrega, liberarReservaEntrega } from '../../services/contenedorReserva.service';
import { finalizarRetiro } from '../../services/retiro.service';
import { simularDisponibilidad, ParadaSimulada, CapacidadCamion, CAPACIDAD_CAMION_DEFAULT } from './disponibilidad.service';
import { avisarChoferViaje, avisarChoferRecambio, avisarSiguienteParadaDesde } from '../viajes/viajes.routes';
import { notificarClientePedidoConfirmado } from '../whatsapp/notificacionesCliente';
import { motivoErrorWa, sendText } from '../whatsapp/graphApi';
import { notificarEnvioFallido } from '../whatsapp/alertaEnvio';
import { emitRecursoActualizado } from '../../config/socket';
import { despacharPrimeraParada } from '../../services/despachoRutas.service';
import { hoyMendozaISO } from '../../services/fechas.service';

export const rutasRouter = Router();
rutasRouter.use(requireAuth);

function fail(msg: string, status = 409): never {
  const err: any = new Error(msg);
  err.status = status;
  throw err;
}

/**
 * La ruta "ya arrancó" si tiene al menos una parada confirmada (reservada y
 * avisada al chofer vía POST /:id/confirmar). Reemplaza al viejo
 * `ruta.estado === 'en_curso'` para decidir el `origen` de una parada nueva
 * ('planificada' vs 'agregada_en_dia') ahora que la ruta no tiene estado.
 */
async function rutaYaEnCurso(c: PoolClient, rutaId: string): Promise<boolean> {
  const { rows } = await c.query<{ existe: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM viajes WHERE ruta_id = $1 AND ruta_confirmada_en IS NOT NULL) AS existe`,
    [rutaId],
  );
  return rows[0]?.existe ?? false;
}

/**
 * Una parada que el chofer ya marcó como hecha (`completada_en`), o que es la
 * parada siguiente activa a la que está yendo el chofer (la inmediatamente posterior
 * a una completada, o la primera de una ruta confirmada), está bloqueada / en curso:
 * no se cancela, no se quita, no se mueve a otra ruta ni se reordena.
 */
async function assertParadaViajeNoFinalizada(
  c: PoolClient, rutaId: string, paradaId: string, accion: string,
): Promise<void> {
  const { rows } = await c.query<{ completada_en: string | null; orden: number; ruta_confirmada_en: string | null }>(
    `SELECT v.completada_en, v.orden, v.ruta_confirmada_en
       FROM viajes v
      WHERE v.ruta_id = $1
        AND (v.id = $2 OR v.grupo_id = (SELECT grupo_id FROM viajes WHERE id = $2))`,
    [rutaId, paradaId],
  );
  if (rows.length === 0) return;
  if (rows.some((r) => r.completada_en != null)) {
    fail(`Esta parada ya la terminó el chofer; no se puede ${accion}.`);
  }

  // Si la parada está confirmada, chequear si es la parada activa a la que está yendo el chofer
  // (es decir, la primera parada no completada de la ruta).
  const ordenParada = rows[0].orden;
  if (rows.some((r) => r.ruta_confirmada_en != null)) {
    const { rows: anterioresPendientes } = await c.query<{ id: string }>(
      `SELECT id FROM viajes
        WHERE ruta_id = $1 AND orden < $2 AND completada_en IS NULL
        LIMIT 1`,
      [rutaId, ordenParada],
    );
    // Si no hay paradas anteriores pendientes, significa que el chofer ya completó las anteriores
    // (o es la primera) y está yendo a entregar/retirar esta parada ahora mismo.
    if (anterioresPendientes.length === 0) {
      fail(`El chofer ya está yendo a esta parada en su recorrido activo; no se puede ${accion}.`);
    }
  }
}

interface ViajeParada {
  id: string;
  orden: number;
  tipo: 'entrega' | 'retiro';
  contenedor_numero: string | null;
  destino_direccion: string | null;
  destino_lat: number | null;
  destino_lng: number | null;
  horario_preferido: string | null;
  hora_estimada: string | null;
  zona: string | null;
  cliente_telefono: string | null;
  grupo_id: string | null;
  estado: string;
  notas: string | null;
  ubicacion_id: string | null;
  origen: 'planificada' | 'agregada_en_dia';
  completada_en: string | null;
  ruta_confirmada_en: string | null;
  chofer_notificado_en: string | null;
  pago_id: string | null;
}

interface VaciadoParada {
  id: string;
  orden: number;
  ubicacion_id: string | null;
  ubicacion_nombre: string | null;
  notas: string | null;
  contenedor_numero: string | null;
  /** Estado REAL y en vivo del contenedor (contenedores.estado) — 'retirado' = todavía lleno, esperando que se vacíe. */
  contenedor_estado: string | null;
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
  // Las 4 lecturas son independientes entre sí — se disparan en paralelo en
  // vez de una detrás de otra. Esta función se llama muy seguido (hasta 5
  // veces por reordenamiento, ver resolverVaciadosAutomaticos), así que cada
  // ida y vuelta de red que se ahorra acá se multiplica varias veces.
  const [viajes, vaciadosRows, disponiblesRows, capacidadRows] = await Promise.all([
    ejecutar(
      `SELECT id, orden, tipo, contenedor_numero, destino_direccion, destino_lat, destino_lng,
              horario_preferido, hora_estimada, zona, cliente_telefono,
              grupo_id, estado, notas, ubicacion_id, origen, completada_en, ruta_confirmada_en, chofer_notificado_en, pago_id
         FROM viajes WHERE ruta_id = $1 ORDER BY orden`,
      [rutaId],
    ) as Promise<ViajeParada[]>,
    ejecutar(
      `SELECT rv.id, rv.orden, rv.ubicacion_id, u.nombre AS ubicacion_nombre, rv.notas,
              rv.contenedor_numero, c.estado AS contenedor_estado
         FROM ruta_vaciados rv
         LEFT JOIN ubicaciones u ON u.id = rv.ubicacion_id
         LEFT JOIN contenedores c ON c.numero = rv.contenedor_numero
        WHERE rv.ruta_id = $1 ORDER BY rv.orden`,
      [rutaId],
    ) as Promise<VaciadoParada[]>,
    ejecutar(
      `SELECT c.numero
         FROM contenedores c
        WHERE c.estado = 'disponible'
          AND c.numero NOT IN (
            SELECT v.contenedor_numero
              FROM viajes v
             WHERE v.contenedor_numero IS NOT NULL
               AND v.estado IN ('programado', 'en_curso')
               -- Comprometido en un viaje activo que NO es parada de ESTA ruta:
               -- otra ruta o todavía sin rutear (bolsa, alta manual, validación
               -- de pago). Ofrecerlo igual llevaba a violar
               -- ux_viajes_activo_por_tipo al asignarlo (un viaje activo por
               -- contenedor+tipo).
               AND (v.ruta_id IS NULL OR v.ruta_id <> $1)
          )`,
      [rutaId],
    ) as Promise<{ numero: string }[]>,
    ejecutar(
      `SELECT ch.capacidad_llenos, ch.capacidad_vacios
         FROM rutas r JOIN choferes ch ON ch.id = r.chofer_id
        WHERE r.id = $1`,
      [rutaId],
    ) as Promise<{ capacidad_llenos: number; capacidad_vacios: number }[]>,
  ]);
  const vaciados = vaciadosRows;
  const disponiblesAlInicio: string[] = disponiblesRows.map((r) => r.numero);
  const capacidad: CapacidadCamion = capacidadRows[0]
    ? { llenos: capacidadRows[0].capacidad_llenos, vacios: capacidadRows[0].capacidad_vacios }
    : CAPACIDAD_CAMION_DEFAULT;

  // Estado REAL de los contenedores de cada retiro de esta ruta: si el
  // chofer ya lo vació por WhatsApp sin pasar por una parada de vaciado de
  // ESTA ruta (ej. retiros de antes de que el vaciado automático quedara
  // linkeado a un contenedor, o un vaciado hecho por el menú suelto del
  // chofer), la simulación lo daba por "pendiente de vaciar" para siempre —
  // ver yaVaciadoEnRealidad en disponibilidad.service.ts.
  const numerosRetiro = [...new Set(viajes.filter((v) => v.tipo === 'retiro' && v.contenedor_numero).map((v) => v.contenedor_numero as string))];
  const estadosReales = numerosRetiro.length
    ? await ejecutar(`SELECT numero, estado FROM contenedores WHERE numero = ANY($1)`, [numerosRetiro]) as { numero: string; estado: string }[]
    : [];
  const estadoRealPorNumero = new Map(estadosReales.map((r) => [r.numero, r.estado]));

  const paradasSimuladas: ParadaSimulada[] = [
    ...viajes.map((v) => ({
      orden: v.orden, tipoParada: 'viaje' as const, viajeTipo: v.tipo, contenedorNumero: v.contenedor_numero,
      completada: v.completada_en != null,
      ...(v.tipo === 'retiro' && v.contenedor_numero
        ? { yaVaciadoEnRealidad: estadoRealPorNumero.get(v.contenedor_numero) !== 'retirado' }
        : {}),
    })),
    ...vaciados.map((v) => ({ orden: v.orden, tipoParada: 'vaciado' as const })),
  ];
  const { porOrden, liberadosPor, advertencias } = simularDisponibilidad(paradasSimuladas, disponiblesAlInicio, capacidad);

  return { viajes, vaciados, porOrden, liberadosPor, advertencias, disponiblesAlInicio };
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
 * antes — así el operador no tiene que acordarse de agregarla a mano en
 * cada recambio. Tope de 5 iteraciones: cada inserción resuelve al menos una
 * advertencia, así que en la práctica converge en 1-2 vueltas.
 *
 * Tiene que ir ANTES (en `faltante.orden`, empujando esa parada y el resto
 * para atrás), no después: la advertencia depende de cuántos llenos ya
 * estaban a bordo ANTES de esa parada — insertarlo después nunca la
 * resolvía, así que la misma parada volvía a marcar la advertencia en cada
 * vuelta del loop y cada llamada apilaba hasta 5 vaciados de más sin
 * arreglar nada (bug real: "se agregan vaciados infinitamente" cada vez que
 * se tocaba la ruta).
 */
async function resolverVaciadosAutomaticos(c: PoolClient, rutaId: string): Promise<void> {
  const ejecutar = async (sql: string, params: any[]) => (await c.query(sql, params)).rows;
  for (let intento = 0; intento < 5; intento++) {
    const { advertencias } = await calcularDisponibilidadRuta(rutaId, ejecutar);
    const faltante = advertencias.find((a) => a.tipo === 'lleno_sin_vaciar');
    if (!faltante) return;
    await insertarVaciadoAutomatico(c, rutaId, faltante.orden);
  }
}

/**
 * Inserta una parada de vaciado en `orden`, corriendo el resto de la
 * secuencia una posición para atrás. `contenedorNumero`: cuál contenedor se
 * va a vaciar ahí — se pasa cuando se sabe (justo después del retiro que lo
 * trae), y queda sin link cuando lo dispara el chequeo de capacidad genérico
 * (resolverVaciadosAutomaticos), que solo sabe la posición, no de cuál
 * contenedor puntual se trata.
 */
async function insertarVaciadoAutomatico(
  c: PoolClient, rutaId: string, orden: number, contenedorNumero: string | null = null,
): Promise<void> {
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
    `INSERT INTO ruta_vaciados (ruta_id, orden, ubicacion_id, contenedor_numero, notas) VALUES ($1,$2,$3,$4,$5)`,
    [rutaId, orden, ubicacion?.id ?? null, contenedorNumero, 'Vaciado agregado automáticamente.'],
  );
}

const nuevaRutaSchema = z.object({
  fecha: z.string(),
  chofer_id: z.string().uuid(),
  notas: z.string().optional(),
});

/**
 * GET /api/rutas?fecha=&chofer_id=&pendientes=1
 * `pendientes=1`: solo rutas con alguna parada confirmada que el chofer
 * todavía no terminó — es el reemplazo de `?estado=en_curso` ahora que la
 * ruta no tiene ciclo de vida (ver "ruta viva", migración 0044).
 */
rutasRouter.get('/', async (req: Request, res: Response) => {
  const { fecha, chofer_id: choferId, pendientes } = req.query as Record<string, string>;
  const conds: string[] = [];
  const params: any[] = [];
  if (fecha) { params.push(fecha); conds.push(`r.fecha = $${params.length}`); }
  if (choferId) { params.push(choferId); conds.push(`r.chofer_id = $${params.length}`); }
  if (pendientes) {
    conds.push(`EXISTS (
      SELECT 1 FROM viajes v
       WHERE v.ruta_id = r.id
         AND v.ruta_confirmada_en IS NOT NULL AND v.completada_en IS NULL
         AND v.estado IN ('programado', 'en_curso'))`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await query(
    `SELECT r.id, r.fecha, r.chofer_id, c.nombre AS chofer_nombre, r.patente, r.notas, r.version, r.creado_en
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
      res.status(409).json({ error: 'Ya existe una ruta para este chofer en esta fecha.' });
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
            v.destino_lat, v.destino_lng, v.horario_preferido, v.hora_estimada,
            v.cliente_telefono, v.grupo_id, v.notas, v.creado_en,
            v.remito, v.importe, v.es_cuenta_corriente, v.ubicacion_direccion, v.direccion_verificada,
            NULLIF(cl.nombre, 'Sin nombre') AS cliente_nombre,
            (v.tipo = 'entrega') AS planificable
       FROM viajes v
       LEFT JOIN clientes cl ON cl.telefono = v.cliente_telefono
      WHERE ${conds.join(' AND ')}
      ORDER BY v.zona NULLS LAST, v.fecha, v.creado_en`,
    params,
  );
  res.json(rows);
});

/**
 * POST /api/rutas/bolsa/:viajeId/cancelar — cancela un pedido que un cliente
 * pidió cancelar por teléfono, mientras todavía está sin rutear. Si es un
 * recambio (grupo_id), cancela las dos mitades juntas. Le avisa al cliente
 * por WhatsApp invitándolo a volver a pedir con el menú.
 */
rutasRouter.post('/bolsa/:viajeId/cancelar', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { viajeId } = req.params;
  try {
    const resultado = await withTx(async (c) => {
      const { rows } = await c.query<{ id: string; grupo_id: string | null; ruta_id: string | null; estado: string; cliente_telefono: string | null }>(
        `SELECT id, grupo_id, ruta_id, estado, cliente_telefono FROM viajes WHERE id = $1 FOR UPDATE`,
        [viajeId],
      );
      const viaje = rows[0];
      if (!viaje) fail('Pedido no encontrado.', 404);
      if (viaje!.ruta_id !== null) fail('Este pedido ya está asignado a una ruta; no se puede cancelar desde la bolsa.');
      if (viaje!.estado === 'cancelado') fail('Este pedido ya estaba cancelado.');

      const ids = [viaje!.id];
      if (viaje!.grupo_id) {
        const { rows: pareja } = await c.query<{ id: string; ruta_id: string | null }>(
          `SELECT id, ruta_id FROM viajes WHERE grupo_id = $1 AND id <> $2 FOR UPDATE`,
          [viaje!.grupo_id, viaje!.id],
        );
        for (const p of pareja) {
          if (p.ruta_id !== null) fail('La otra mitad de este recambio ya está asignada a una ruta; no se puede cancelar desde la bolsa.');
          ids.push(p.id);
        }
      }

      await c.query(`UPDATE viajes SET estado = 'cancelado' WHERE id = ANY($1::uuid[])`, [ids]);
      return { viajeId: viaje!.id, telefono: viaje!.cliente_telefono };
    });

    res.json({ ok: true });
    emitRecursoActualizado('viajes');

    if (resultado.telefono) {
      sendText(
        resultado.telefono,
        '❌ Tu pedido fue *cancelado*, tal como nos pediste.\n\n' +
          'Cuando quieras volver a pedir, escribinos *MENU* y arrancamos de nuevo. ¡Gracias por confiar en Moratrans! 🙌',
      ).catch((e) => {
        const motivo = motivoErrorWa(e);
        console.error('Error avisando cancelación al cliente:', motivo);
        notificarEnvioFallido(resultado.viajeId, `cliente ${resultado.telefono}`, 'aviso de cancelación', motivo).catch(
          (e2) => console.error('Error registrando alerta de envío fallido:', e2),
        );
      });
    }
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

/** GET /api/rutas/:id — ruta + paradas ordenadas + disponibilidad resuelta por parada de entrega. */
rutasRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const [[ruta], disponibilidad] = await Promise.all([
    query(
      `SELECT r.id, r.fecha, r.chofer_id, c.nombre AS chofer_nombre, r.patente, r.notas, r.version, r.creado_en
         FROM rutas r LEFT JOIN choferes c ON c.id = r.chofer_id WHERE r.id = $1`,
      [id],
    ),
    calcularDisponibilidadRuta(id),
  ]);
  if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada.' });

  // Contenedores que este chofer ya tiene retirados (lleno, a bordo del
  // camión) y todavía sin vaciar — mismo criterio que el menú "🗑️ Confirmar
  // vaciado" del chofer en WhatsApp. Independiente de si ya tienen o no una
  // parada de vaciado linkeada en esta ruta: sirve para el selector del
  // formulario manual "Agregar vaciado" (ver POST .../paradas/vaciado).
  // Contenedores 'disponible' que no entran en el stock de ESTA ruta porque
  // ya están elegidos en una entrega activa de OTRA ruta (o sin rutear)
  // todavía sin confirmar — para que el panel pueda explicar el motivo en
  // vez de un "sin stock" genérico cuando el operador esperaba verlos (la
  // pantalla de Contenedores los sigue mostrando "disponible" sin ninguna
  // pista de por qué no aparecen acá).
  const [pendientesDeVaciar, comprometidosOtraRuta] = await Promise.all([
    (ruta as any).chofer_id
      ? query<{ contenedor_numero: string }>(
          `SELECT DISTINCT contenedor_numero FROM viajes
            WHERE chofer_id = $1 AND tipo = 'retiro' AND estado = 'en_curso' AND contenedor_numero IS NOT NULL`,
          [(ruta as any).chofer_id],
        )
      : Promise.resolve([]),
    query<{ numero: string; chofer_nombre: string | null }>(
      `SELECT DISTINCT c.numero, ch.nombre AS chofer_nombre
         FROM contenedores c
         JOIN viajes v ON v.contenedor_numero = c.numero
         LEFT JOIN choferes ch ON ch.id = v.chofer_id
        WHERE c.estado = 'disponible'
          AND v.tipo = 'entrega'
          AND v.estado IN ('programado', 'en_curso')
          AND (v.ruta_id IS NULL OR v.ruta_id <> $1)`,
      [id],
    ),
  ]);

  const { viajes, vaciados, porOrden, advertencias, disponiblesAlInicio } = disponibilidad;

  const paradas = [
    ...viajes.map((v) => ({
      tipo_parada: 'viaje' as const,
      id: v.id,
      orden: v.orden,
      viaje_tipo: v.tipo,
      contenedor_numero: v.contenedor_numero,
      destino_direccion: v.destino_direccion,
      destino_lat: v.destino_lat,
      destino_lng: v.destino_lng,
      horario_preferido: v.horario_preferido,
      hora_estimada: v.hora_estimada,
      zona: v.zona,
      cliente_telefono: v.cliente_telefono,
      grupo_id: v.grupo_id,
      estado: v.estado,
      notas: v.notas,
      origen: v.origen,
      completada_en: v.completada_en,
      ruta_confirmada_en: v.ruta_confirmada_en,
      chofer_notificado_en: v.chofer_notificado_en,
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
      contenedor_numero: v.contenedor_numero,
      contenedor_estado: v.contenedor_estado,
    })),
  ].sort((a, b) => {
    if (a.orden !== b.orden) return a.orden - b.orden;
    return prioridadParada(a.tipo_parada, (a as any).viaje_tipo) - prioridadParada(b.tipo_parada, (b as any).viaje_tipo);
  });

  // Stock real que la simulación usa como punto de partida: contenedores
  // 'disponible' que NO están comprometidos con ningún viaje activo ajeno a
  // esta ruta (otra ruta, o sin rutear todavía). Es la MISMA lista contra la
  // que se validan los selects de cada parada — el panel del frontend la usa
  // tal cual para no inflar el número con contenedores que no va a poder
  // asignar.
  res.json({
    ...ruta, paradas, advertencias, stock_deposito: disponiblesAlInicio,
    contenedores_pendientes_vaciar: pendientesDeVaciar.map((p) => p.contenedor_numero),
    contenedores_comprometidos_otra_ruta: comprometidosOtraRuta,
  });
});

const nuevaParadaSchema = z.object({
  viaje_id: z.string().uuid(),
  // Posición (valor de `orden`) donde insertar la parada. Si se omite, va al
  // final. Si cae en el medio, se corre una posición para atrás todo lo que
  // esté en esa posición o después (mismo criterio que insertarVaciadoAutomatico).
  orden: z.number().int().positive().optional(),
});

/** POST /api/rutas/:id/paradas — adjunta un viaje YA EXISTENTE (de la cola sin rutear) a la ruta. La ruta siempre está abierta: el 80% del trabajo entra durante el día. */
rutasRouter.post('/:id/paradas', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId } = req.params;
  const parsed = nuevaParadaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { viaje_id, orden: ordenPedido } = parsed.data;

  try {
    const resultado = await withTx(async (c) => {
      const { rows: rutaRows } = await c.query<{ chofer_id: string; fecha: string; patente: string | null }>(
        'SELECT chofer_id, fecha, patente FROM rutas WHERE id = $1 FOR UPDATE',
        [rutaId],
      );
      const ruta = rutaRows[0];
      if (!ruta) fail('Ruta no encontrada.', 404);

      const origen = (await rutaYaEnCurso(c, rutaId)) ? 'agregada_en_dia' : 'planificada';

      const { rows: ordenRows } = await c.query<{ max: number | null }>(
        `SELECT MAX(orden) AS max FROM (
           SELECT orden FROM viajes WHERE ruta_id = $1
           UNION ALL SELECT orden FROM ruta_vaciados WHERE ruta_id = $1
         ) t`,
        [rutaId],
      );
      const maxOrden = ordenRows[0]?.max ?? 0;
      // Una parada nueva no se puede colar antes (ni en el lugar) de una parada
      // que el chofer ya terminó: esas mantienen su `orden`. El piso es la
      // posición justo después de la última finalizada.
      const { rows: finRows } = await c.query<{ max: number | null }>(
        `SELECT MAX(orden) AS max FROM viajes WHERE ruta_id = $1 AND completada_en IS NOT NULL`,
        [rutaId],
      );
      const pisoOrden = (finRows[0]?.max ?? 0) + 1;
      // Posición destino: la pedida (acotada a [pisoOrden, maxOrden+1]) o el final.
      const nuevoOrden = ordenPedido != null
        ? Math.min(Math.max(pisoOrden, ordenPedido), maxOrden + 1)
        : maxOrden + 1;

      // Si se inserta en el medio, correr una posición para atrás todo lo que
      // esté en esa posición o después. Fase temporal negativa para no chocar
      // contra las constraints UNIQUE de orden (igual que insertarVaciadoAutomatico).
      if (nuevoOrden <= maxOrden) {
        await c.query(`UPDATE viajes SET orden = -(orden + 1) WHERE ruta_id = $1 AND orden >= $2`, [rutaId, nuevoOrden]);
        await c.query(`UPDATE ruta_vaciados SET orden = -(orden + 1) WHERE ruta_id = $1 AND orden >= $2`, [rutaId, nuevoOrden]);
        await c.query(`UPDATE viajes SET orden = -orden WHERE ruta_id = $1 AND orden < 0`, [rutaId]);
        await c.query(`UPDATE ruta_vaciados SET orden = -orden WHERE ruta_id = $1 AND orden < 0`, [rutaId]);
      }

      const { rows: viajeRows } = await c.query<{ id: string; grupo_id: string | null; tipo: string; contenedor_numero: string | null }>(
        `UPDATE viajes SET ruta_id = $1, orden = $2, chofer_id = $3, patente = $4, fecha = $5, origen = $6
           WHERE id = $7 AND ruta_id IS NULL
           RETURNING id, grupo_id, tipo, contenedor_numero`,
        [rutaId, nuevoOrden, ruta!.chofer_id, ruta!.patente, ruta!.fecha, origen, viaje_id],
      );
      const viaje = viajeRows[0];
      if (!viaje) fail('Ese viaje no existe o ya está en una ruta.');

      // Recambio: la pareja (mismo grupo_id) va a la misma visita física.
      let contenedorRetiro = viaje!.tipo === 'retiro' ? viaje!.contenedor_numero : null;
      if (viaje!.grupo_id) {
        const { rows: parejaRows } = await c.query<{ tipo: string; contenedor_numero: string | null }>(
          `UPDATE viajes SET ruta_id = $1, orden = $2, chofer_id = $3, patente = $4, fecha = $5, origen = $6
             WHERE grupo_id = $7 AND id <> $8 AND ruta_id IS NULL
             RETURNING tipo, contenedor_numero`,
          [rutaId, nuevoOrden, ruta!.chofer_id, ruta!.patente, ruta!.fecha, origen, viaje!.grupo_id, viaje!.id],
        );
        const pareja = parejaRows[0];
        if (pareja?.tipo === 'retiro') contenedorRetiro = pareja.contenedor_numero;
      }

      // Recambio: grupo_id implica que la mitad "retiro" existe aunque el
      // viaje_id apuntado haya sido el de la mitad "entrega". Cada retiro
      // (solo o de un recambio) se vacía solo: se agrega automáticamente un
      // vaciado justo después, con el contenedor ya linkeado, así el operador
      // no tiene que acordarse ni adivinar cuál era.
      if (viaje!.tipo === 'retiro' || viaje!.grupo_id) {
        await insertarVaciadoAutomatico(c, rutaId, nuevoOrden + 1, contenedorRetiro);
      }

      // Mismo lock optimista que ya usa PATCH /:id/orden: agregar una parada
      // también cambia la composición de la ruta, así que un reorder basado
      // en una `version` anterior a esto tiene que detectarse como stale.
      await c.query(`UPDATE rutas SET version = version + 1 WHERE id = $1`, [rutaId]);

      return { orden: nuevoOrden };
    });
    emitRecursoActualizado('viajes');
    res.status(201).json(resultado);
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

const nuevoVaciadoSchema = z.object({
  ubicacion_id: z.string().uuid().optional(),
  contenedor_numero: z.string().optional(),
  notas: z.string().optional(),
});

/** POST /api/rutas/:id/paradas/vaciado — agrega una parada de vaciado (sin pedido asociado). */
rutasRouter.post('/:id/paradas/vaciado', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId } = req.params;
  const parsed = nuevoVaciadoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { ubicacion_id, contenedor_numero, notas } = parsed.data;

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
      const { rows: rutaRows } = await c.query<{ id: string; chofer_id: string | null }>(
        'SELECT id, chofer_id FROM rutas WHERE id = $1 FOR UPDATE', [rutaId],
      );
      if (!rutaRows[0]) fail('Ruta no encontrada.', 404);

      // Si se eligió un contenedor, tiene que ser uno que ESTE chofer tenga
      // efectivamente retirado y sin vaciar — mismo criterio que usa
      // finalizarRetiro para encontrarlo, así no se linkea un contenedor que
      // después esa función no va a poder confirmar.
      if (contenedor_numero) {
        const { rows: retiroRows } = await c.query(
          `SELECT 1 FROM viajes WHERE contenedor_numero = $1 AND tipo = 'retiro' AND estado = 'en_curso' AND chofer_id = $2`,
          [contenedor_numero, rutaRows[0].chofer_id],
        );
        if (retiroRows.length === 0) {
          fail(`El contenedor ${contenedor_numero} no figura retirado y pendiente de vaciar para este chofer.`);
        }
      }

      const { rows: ordenRows } = await c.query<{ max: number | null }>(
        `SELECT MAX(orden) AS max FROM (
           SELECT orden FROM viajes WHERE ruta_id = $1
           UNION ALL SELECT orden FROM ruta_vaciados WHERE ruta_id = $1
         ) t`,
        [rutaId],
      );
      const nuevoOrden = (ordenRows[0]?.max ?? 0) + 1;

      const { rows } = await c.query(
        `INSERT INTO ruta_vaciados (ruta_id, orden, ubicacion_id, contenedor_numero, notas) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [rutaId, nuevoOrden, ubicacion?.id ?? null, contenedor_numero ?? null, notas ?? null],
      );
      await c.query(`UPDATE rutas SET version = version + 1 WHERE id = $1`, [rutaId]);
      return rows[0];
    });
    res.status(201).json(resultado);
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

/**
 * POST /api/rutas/:id/paradas/vaciado/:paradaId/confirmar — marca desde el
 * panel que el contenedor linkeado a esta parada ya se vació. Hace
 * exactamente lo mismo que el chofer cuando confirma "🗑️ Ya vacié" por
 * WhatsApp (misma función, finalizarRetiro): pasa el contenedor de
 * 'retirado' a 'disponible', cierra el viaje, libera reservas futuras, etc.
 * Para cuando conviene resolverlo desde acá en vez de esperar al chofer
 * (volvió a la empresa otro día, el chofer no tiene WhatsApp a mano, etc.).
 */
rutasRouter.post('/:id/paradas/vaciado/:paradaId/confirmar', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId, paradaId } = req.params;
  const [vaciado] = await query<{ contenedor_numero: string | null; orden: number }>(
    `SELECT contenedor_numero, orden FROM ruta_vaciados WHERE id = $1 AND ruta_id = $2`,
    [paradaId, rutaId],
  );
  if (!vaciado) return res.status(404).json({ error: 'Parada no encontrada.' });
  if (!vaciado.contenedor_numero) {
    return res.status(409).json({ error: 'Esta parada no tiene un contenedor asociado para confirmar.' });
  }

  const resultado = await finalizarRetiro(vaciado.contenedor_numero, `operador:${req.user!.id}`);
  if ('error' in resultado) return res.status(409).json({ error: resultado.error });
  res.json({ ok: true });

  // Mismo criterio que cuando lo confirma el chofer por WhatsApp (ver
  // aplicarVaciado en chofer.flow.ts): si esto desatasca la secuencia de la
  // ruta, seguir avisando — acá puede ser la próxima parada de viaje, o
  // incluso otro vaciado pendiente antes.
  avisarSiguienteParadaDesde(rutaId, vaciado.orden).catch((e) =>
    console.error('Error avisando siguiente parada tras confirmar vaciado desde el panel:', e.message),
  );
});

/**
 * DELETE /api/rutas/:id/paradas/:tipo/:paradaId — desprende una parada,
 * vuelve a la cola.
 *
 * Bloquea si la parada ya la terminó el chofer (`completada_en`): una parada
 * hecha no se toca más. Si la parada de entrega ya había sido confirmada
 * (`ruta_confirmada_en`, contenedor reservado vía POST /:id/confirmar), libera
 * esa reserva y limpia el flag — si no, quedaba "reservado fantasma" y, peor,
 * si la parada se re-rutea más adelante, /confirmar la saltea creyendo que ya
 * está confirmada y nunca vuelve a avisarle al chofer (ver ruta_confirmada_en
 * más abajo).
 */
rutasRouter.delete('/:id/paradas/:tipo/:paradaId', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId, tipo, paradaId } = req.params;
  if (tipo !== 'viaje' && tipo !== 'vaciado') return res.status(400).json({ error: 'Tipo de parada inválido.' });
  const actualizadoPor = `operador:${req.user!.id}`;

  try {
    await withTx(async (c) => {
      const { rows: rutaRows } = await c.query<{ id: string }>('SELECT id FROM rutas WHERE id = $1 FOR UPDATE', [rutaId]);
      if (!rutaRows[0]) fail('Ruta no encontrada.', 404);

      if (tipo === 'vaciado') {
        const { rows } = await c.query(`DELETE FROM ruta_vaciados WHERE id = $1 AND ruta_id = $2 RETURNING id`, [paradaId, rutaId]);
        if (rows.length === 0) fail('Parada no encontrada.', 404);
        await c.query(`UPDATE rutas SET version = version + 1 WHERE id = $1`, [rutaId]);
        return;
      }

      await assertParadaViajeNoFinalizada(c, rutaId, paradaId, 'quitar de la ruta');

      const { rows } = await c.query<{ id: string; grupo_id: string | null; tipo: string; contenedor_numero: string | null; ruta_confirmada_en: string | null }>(
        `UPDATE viajes SET ruta_id = NULL, orden = NULL, chofer_id = NULL, patente = NULL, ruta_confirmada_en = NULL
           WHERE id = $1 AND ruta_id = $2 RETURNING id, grupo_id, tipo, contenedor_numero, ruta_confirmada_en`,
        [paradaId, rutaId],
      );
      const viaje = rows[0];
      if (!viaje) fail('Parada no encontrada.', 404);
      if (viaje!.tipo === 'entrega' && viaje!.contenedor_numero) {
        await liberarReservaEntrega(c, viaje!.contenedor_numero, actualizadoPor);
      }
      if (viaje!.grupo_id) {
        const { rows: parejaRows } = await c.query<{ tipo: string; contenedor_numero: string | null }>(
          `UPDATE viajes SET ruta_id = NULL, orden = NULL, chofer_id = NULL, patente = NULL, ruta_confirmada_en = NULL
             WHERE grupo_id = $1 AND id <> $2 AND ruta_id = $3
             RETURNING tipo, contenedor_numero`,
          [viaje!.grupo_id, viaje!.id, rutaId],
        );
        const pareja = parejaRows[0];
        if (pareja?.tipo === 'entrega' && pareja.contenedor_numero) {
          await liberarReservaEntrega(c, pareja.contenedor_numero, actualizadoPor);
        }
      }
      await c.query(`UPDATE rutas SET version = version + 1 WHERE id = $1`, [rutaId]);
    });
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('contenedores');
    res.json({ ok: true });
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

const moverParadaSchema = z.object({ ruta_destino_id: z.string().uuid() });

/**
 * POST /api/rutas/:id/paradas/:tipo/:paradaId/mover — mueve una parada
 * directo a otra ruta (a diferencia de DELETE, que la desprende a la cola en
 * dos pasos). Caso de uso: se rompe un camión o falta un chofer y hay que
 * repartir sus paradas entre otros camiones ya en curso.
 *
 * Bloquea si la parada ya la terminó el chofer (`completada_en`). Si la parada
 * de entrega ya estaba confirmada, libera la reserva del contenedor y limpia
 * `ruta_confirmada_en` — la ruta destino la va a volver a confirmar/reservar
 * por su cuenta, con su propia secuencia y disponibilidad (puede ser distinta
 * a la de la ruta de origen).
 */
rutasRouter.post('/:id/paradas/:tipo/:paradaId/mover', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaOrigenId, tipo, paradaId } = req.params;
  if (tipo !== 'viaje' && tipo !== 'vaciado') return res.status(400).json({ error: 'Tipo de parada inválido.' });
  const parsed = moverParadaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { ruta_destino_id: rutaDestinoId } = parsed.data;
  if (rutaDestinoId === rutaOrigenId) return res.status(400).json({ error: 'La ruta de destino tiene que ser distinta de la de origen.' });
  const actualizadoPor = `operador:${req.user!.id}`;

  try {
    const resultado = await withTx(async (c) => {
      const { rows: origenRows } = await c.query<{ id: string }>('SELECT id FROM rutas WHERE id = $1 FOR UPDATE', [rutaOrigenId]);
      if (!origenRows[0]) fail('Ruta de origen no encontrada.', 404);

      const { rows: destRows } = await c.query<{ chofer_id: string; patente: string | null; fecha: string }>(
        'SELECT chofer_id, patente, fecha FROM rutas WHERE id = $1 FOR UPDATE',
        [rutaDestinoId],
      );
      const destino = destRows[0];
      if (!destino) fail('Ruta de destino no encontrada.', 404);

      if (tipo === 'viaje') {
        await assertParadaViajeNoFinalizada(c, rutaOrigenId, paradaId, 'mover a otra ruta');
      }

      const { rows: ordenRows } = await c.query<{ max: number | null }>(
        `SELECT MAX(orden) AS max FROM (
           SELECT orden FROM viajes WHERE ruta_id = $1
           UNION ALL SELECT orden FROM ruta_vaciados WHERE ruta_id = $1
         ) t`,
        [rutaDestinoId],
      );
      const nuevoOrden = (ordenRows[0]?.max ?? 0) + 1;
      const origen = (await rutaYaEnCurso(c, rutaDestinoId)) ? 'agregada_en_dia' : 'planificada';
      const ejecutar = async (sql: string, params: any[]) => (await c.query(sql, params)).rows;

      if (tipo === 'vaciado') {
        const { rows } = await c.query(
          `UPDATE ruta_vaciados SET ruta_id = $1, orden = $2 WHERE id = $3 AND ruta_id = $4 RETURNING id`,
          [rutaDestinoId, nuevoOrden, paradaId, rutaOrigenId],
        );
        if (!rows[0]) fail('Parada no encontrada en la ruta de origen.', 404);
        await c.query(`UPDATE rutas SET version = version + 1 WHERE id = ANY($1)`, [[rutaOrigenId, rutaDestinoId]]);
        const { advertencias } = await calcularDisponibilidadRuta(rutaDestinoId, ejecutar);
        return { orden: nuevoOrden, advertencias };
      }

      const { rows: viajeRows } = await c.query<{ id: string; grupo_id: string | null; tipo: string; contenedor_numero: string | null }>(
        `UPDATE viajes SET ruta_id = $1, orden = $2, chofer_id = $3, patente = $4, fecha = $5, origen = $6, ruta_confirmada_en = NULL
           WHERE id = $7 AND ruta_id = $8
           RETURNING id, grupo_id, tipo, contenedor_numero`,
        [rutaDestinoId, nuevoOrden, destino!.chofer_id, destino!.patente, destino!.fecha, origen, paradaId, rutaOrigenId],
      );
      const viaje = viajeRows[0];
      if (!viaje) fail('Parada no encontrada en la ruta de origen.', 404);
      if (viaje!.tipo === 'entrega' && viaje!.contenedor_numero) {
        await liberarReservaEntrega(c, viaje!.contenedor_numero, actualizadoPor);
      }
      let contenedorRetiro = viaje!.tipo === 'retiro' ? viaje!.contenedor_numero : null;
      if (viaje!.grupo_id) {
        const { rows: parejaRows } = await c.query<{ tipo: string; contenedor_numero: string | null }>(
          `UPDATE viajes SET ruta_id = $1, orden = $2, chofer_id = $3, patente = $4, fecha = $5, origen = $6, ruta_confirmada_en = NULL
             WHERE grupo_id = $7 AND id <> $8 AND ruta_id = $9
             RETURNING tipo, contenedor_numero`,
          [rutaDestinoId, nuevoOrden, destino!.chofer_id, destino!.patente, destino!.fecha, origen, viaje!.grupo_id, viaje!.id, rutaOrigenId],
        );
        const pareja = parejaRows[0];
        if (pareja?.tipo === 'entrega' && pareja.contenedor_numero) {
          await liberarReservaEntrega(c, pareja.contenedor_numero, actualizadoPor);
        }
        if (pareja?.tipo === 'retiro') contenedorRetiro = pareja.contenedor_numero;
      }

      if (viaje!.tipo === 'retiro' || viaje!.grupo_id) {
        await insertarVaciadoAutomatico(c, rutaDestinoId, nuevoOrden + 1, contenedorRetiro);
      }

      await c.query(`UPDATE rutas SET version = version + 1 WHERE id = ANY($1)`, [[rutaOrigenId, rutaDestinoId]]);
      const { advertencias } = await calcularDisponibilidadRuta(rutaDestinoId, ejecutar);
      return { orden: nuevoOrden, advertencias };
    });
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('contenedores');
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
  // tanto — se rechaza en vez de pisarle el trabajo. Obligatorio: el único
  // caller real (Rutas.tsx) siempre lo manda, y que sea opcional dejaba
  // pasar en silencio un bug de frontend que se lo olvidara.
  version: z.number().int(),
});

/**
 * PATCH /api/rutas/:id/orden — reescribe toda la secuencia (no "mover uno").
 * Dos fases (temporal negativo -> final positivo) para no chocar contra las
 * constraints UNIQUE de orden mientras se reordena dentro de la transacción.
 *
 * Antes esto era un UPDATE por parada (dos pasadas → ~2×N idas y vueltas a
 * la base por cada reordenamiento, la operación más frecuente de la pantalla
 * de Rutas). Ahora cada fase es un UPDATE ... FROM unnest(...) por tabla: un
 * puñado de round-trips fijo, no proporcional a la cantidad de paradas.
 */
rutasRouter.patch('/:id/orden', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId } = req.params;
  const parsed = ordenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { secuencia, version } = parsed.data;

  try {
    const resultado = await withTx(async (c) => {
      const { rows: rutaRows } = await c.query<{ version: number }>(
        'SELECT version FROM rutas WHERE id = $1 FOR UPDATE',
        [rutaId],
      );
      const ruta = rutaRows[0];
      if (!ruta) fail('Ruta no encontrada.', 404);
      if (version !== ruta!.version) {
        fail('Alguien más modificó esta ruta mientras tanto. Recargá para ver los cambios y volvé a intentar.');
      }

      const viajeItems = secuencia
        .map((p, i) => ({ ...p, posFinal: i + 1 }))
        .filter((p) => p.tipo === 'viaje');
      const vaciadoItems = secuencia
        .map((p, i) => ({ ...p, posFinal: i + 1 }))
        .filter((p) => p.tipo === 'vaciado');

      // Una parada que el chofer ya terminó (`completada_en`) no se mueve de
      // lugar: su posición final en la secuencia nueva tiene que ser la misma
      // que tiene ahora (un recambio comparte `orden` entre sus dos filas, así
      // que alcanza con chequear la que vino representada en la secuencia).
      const { rows: actuales } = await c.query<{ id: string; orden: number; completada_en: string | null }>(
        `SELECT id, orden, completada_en FROM viajes WHERE ruta_id = $1`,
        [rutaId],
      );
      const ordenPorId = new Map(actuales.map((r) => [r.id, r.orden]));
      const ordenesFinalizadas = new Set(actuales.filter((r) => r.completada_en != null).map((r) => r.orden));
      for (const it of viajeItems) {
        const ordenActual = ordenPorId.get(it.id);
        if (ordenActual != null && ordenesFinalizadas.has(ordenActual) && it.posFinal !== ordenActual) {
          fail('No se puede reordenar: hay paradas que el chofer ya terminó.');
        }
      }

      // Fase 1: temporal negativo (índice dentro de cada tabla alcanza para
      // que sea único; no hace falta que coincida con la posición final).
      if (viajeItems.length > 0) {
        await c.query(
          `UPDATE viajes v SET orden = -x.tmp
             FROM unnest($1::uuid[], $2::int[]) AS x(id, tmp)
            WHERE v.id = x.id AND v.ruta_id = $3`,
          [viajeItems.map((p) => p.id), viajeItems.map((_, i) => i + 1), rutaId],
        );
      }
      if (vaciadoItems.length > 0) {
        await c.query(
          `UPDATE ruta_vaciados v SET orden = -x.tmp
             FROM unnest($1::uuid[], $2::int[]) AS x(id, tmp)
            WHERE v.id = x.id AND v.ruta_id = $3`,
          [vaciadoItems.map((p) => p.id), vaciadoItems.map((_, i) => i + 1), rutaId],
        );
      }

      // Fase 2: posición final positiva.
      if (viajeItems.length > 0) {
        await c.query(
          `UPDATE viajes v SET orden = x.pos
             FROM unnest($1::uuid[], $2::int[]) AS x(id, pos)
            WHERE v.id = x.id AND v.ruta_id = $3`,
          [viajeItems.map((p) => p.id), viajeItems.map((p) => p.posFinal), rutaId],
        );
        // Recambio: la pareja (grupo_id) que no vino explícita en la secuencia
        // (agruparVisitas() del frontend manda un solo id por visita) sigue a
        // la que sí vino — mismo criterio que antes, ahora en un solo UPDATE.
        await c.query(
          `UPDATE viajes v2 SET orden = v1.orden
             FROM viajes v1
            WHERE v1.grupo_id = v2.grupo_id AND v1.grupo_id IS NOT NULL
              AND v1.ruta_id = $1 AND v2.ruta_id = $1
              AND v1.id <> v2.id
              AND v1.id = ANY($2::uuid[])`,
          [rutaId, viajeItems.map((p) => p.id)],
        );
      }
      if (vaciadoItems.length > 0) {
        await c.query(
          `UPDATE ruta_vaciados v SET orden = x.pos
             FROM unnest($1::uuid[], $2::int[]) AS x(id, pos)
            WHERE v.id = x.id AND v.ruta_id = $3`,
          [vaciadoItems.map((p) => p.id), vaciadoItems.map((p) => p.posFinal), rutaId],
        );
      }

      await resolverVaciadosAutomaticos(c, rutaId);

      const { rows: versionRows } = await c.query<{ version: number }>(
        `UPDATE rutas SET version = version + 1 WHERE id = $1 RETURNING version`,
        [rutaId],
      );
      const { advertencias } = await calcularDisponibilidadRuta(rutaId, async (sql, params) => (await c.query(sql, params)).rows);
      return { version: versionRows[0].version, advertencias };
    });
    emitRecursoActualizado('viajes');
    res.json({ ok: true, ...resultado });
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

const contenedorParadaSchema = z.object({ contenedor_numero: z.string().min(1) });

/**
 * PATCH /api/rutas/:id/paradas/:viajeId/contenedor — asigna contenedor
 * validado contra la disponibilidad simulada.
 *
 * Corre dentro de una transacción con la ruta lockeada (FOR UPDATE), mismo
 * patrón que el resto de los endpoints de este archivo: sin esto, dos
 * operadores asignando contenedor a paradas distintas de la misma ruta casi
 * al mismo tiempo podían leer disponibilidad ANTES de que la otra asignación
 * se confirmara y terminar eligiendo el mismo contenedor para las dos.
 */
rutasRouter.patch('/:id/paradas/:viajeId/contenedor', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId, viajeId } = req.params;
  const parsed = contenedorParadaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
  const { contenedor_numero } = parsed.data;

  try {
    await withTx(async (c) => {
      const ejecutar = async (sql: string, params: any[]) => (await c.query(sql, params)).rows;
      const { rows: rutaRows } = await c.query('SELECT id FROM rutas WHERE id = $1 FOR UPDATE', [rutaId]);
      if (!rutaRows[0]) fail('Ruta no encontrada.', 404);

      const { rows: viajeRows } = await c.query<{
        orden: number | null; tipo: string; completada_en: string | null;
        contenedor_numero: string | null; ruta_confirmada_en: string | null; fecha: string;
      }>(
        `SELECT orden, tipo, completada_en, contenedor_numero, ruta_confirmada_en, fecha FROM viajes WHERE id = $1 AND ruta_id = $2`,
        [viajeId, rutaId],
      );
      const viaje = viajeRows[0];
      if (!viaje) fail('Parada no encontrada en esta ruta.', 404);
      if (viaje!.tipo !== 'entrega') fail('Solo se asigna contenedor en una parada de entrega.', 400);
      if (viaje!.completada_en != null) fail('Esta parada ya la terminó el chofer; no se le puede cambiar el contenedor.');
      const contenedorAnterior = viaje!.contenedor_numero;

      const { porOrden } = await calcularDisponibilidadRuta(rutaId, ejecutar);
      const disponibles = porOrden.get(viaje!.orden!) ?? [];
      if (!disponibles.includes(contenedor_numero)) {
        fail(`El contenedor ${contenedor_numero} no está disponible en esta parada.`, 409);
      }

      // Barrera dura contra ux_viajes_activo_por_tipo (un viaje activo por
      // contenedor+tipo): si el contenedor ya está en otra entrega activa
      // —otra ruta, o sin rutear— sin esto el UPDATE de abajo tira un 500 de
      // constraint en vez de este 409.
      const { rows: conflicto } = await c.query(
        `SELECT 1 FROM viajes
          WHERE contenedor_numero = $1 AND tipo = 'entrega'
            AND estado IN ('programado', 'en_curso') AND id <> $2
          LIMIT 1`,
        [contenedor_numero, viajeId],
      );
      if (conflicto[0]) {
        fail(`El contenedor ${contenedor_numero} ya está asignado a otra entrega activa.`, 409);
      }

      // Si esta parada ya estaba confirmada (reservó un contenedor al
      // confirmar la ruta, ver POST /:id/confirmar), cambiarlo acá tiene que
      // actualizar la reserva real además del puntero en `viajes` — si no, el
      // contenedor viejo queda "reservado" fantasma para siempre (sin ningún
      // viaje activo que lo use) y el nuevo sigue figurando "disponible"
      // aunque ya esté comprometido con este cliente (bug real: pasó en
      // producción armando una ruta para el día siguiente). Antes de
      // confirmar no hace falta tocar `contenedores` acá — la reserva de
      // verdad recién pasa al confirmar.
      if (viaje!.ruta_confirmada_en != null && contenedorAnterior !== contenedor_numero) {
        if (contenedorAnterior) await liberarReservaEntrega(c, contenedorAnterior, `operador:${req.user!.id}`);
        await reservarParaEntrega(c, contenedor_numero, viaje!.fecha, `operador:${req.user!.id}`, { excluirViajeId: viajeId });
      }

      await c.query(`UPDATE viajes SET contenedor_numero = $1 WHERE id = $2`, [contenedor_numero, viajeId]);
    });
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('contenedores');
    res.json({ ok: true });
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
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

      const { rows: rutaRows } = await c.query<{ fecha: string; chofer_id: string }>(
        'SELECT fecha, chofer_id FROM rutas WHERE id = $1 FOR UPDATE',
        [rutaId],
      );
      const ruta = rutaRows[0];
      if (!ruta) fail('Ruta no encontrada.', 404);

      const { viajes, porOrden, liberadosPor, advertencias } = await calcularDisponibilidadRuta(rutaId, ejecutar);
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
      // próxima corrida de `confirmar`. Si a esta altura todavía queda una
      // advertencia de capacidad ("lleno sin vaciar") sin resolver en esta
      // parada, se trata como una parada no confirmable más — igual que un
      // contenedor no disponible — en vez de confirmarla y avisarle al
      // chofer una visita que el camión no puede hacer todavía.
      const retiros = viajes.filter((v) => v.tipo === 'retiro' && !v.ruta_confirmada_en);
      for (const v of retiros) {
        const advertenciaCapacidad = advertencias.find((a) => a.tipo === 'lleno_sin_vaciar' && a.orden === v.orden);
        if (advertenciaCapacidad) {
          pendientes.push(advertenciaCapacidad.mensaje);
          continue;
        }
        await c.query(`UPDATE viajes SET ruta_confirmada_en = now() WHERE id = $1`, [v.id]);
        confirmadasAhora.push(v);
      }

      return { confirmadasAhora, choferId: ruta!.chofer_id, fecha: ruta!.fecha, pendientes };
    });
    emitRecursoActualizado('viajes');
    emitRecursoActualizado('contenedores');

    // Si la ruta es para HOY (o del pasado), se despacha la primera parada al chofer de inmediato.
    // Si la ruta es para MAÑANA (o fecha futura), se confirma y reserva todo el stock,
    // pero el aviso al chofer se posterga para la mañana del día del reparto (a las 07:30 AM vía cron).
    const esRutaHoy = resultado.fecha <= hoyMendozaISO();
    if (esRutaHoy) {
      await despacharPrimeraParada(rutaId, resultado.choferId);
    } else {
      console.log(`[rutas] Ruta ${rutaId} para el ${resultado.fecha} confirmada. El chofer recibirá su primera parada a las 07:30 AM.`);
    }

    // Notificación automática a los clientes con paradas recién confirmadas: pedido confirmado con fecha pactada
    for (const v of resultado.confirmadasAhora) {
      if (v.cliente_telefono) {
        notificarClientePedidoConfirmado({
          clienteTelefono: v.cliente_telefono,
          tipo: v.tipo,
          destinoDireccion: v.destino_direccion,
          fecha: resultado.fecha,
        }).catch((e) => console.error('Error notificando pedido confirmado al cliente:', e));
      }
    }

    res.json({
      ok: true,
      confirmadas: resultado.confirmadasAhora.length,
      pendientes: resultado.pendientes,
      despachada: esRutaHoy,
      fechaRuta: resultado.fecha,
    });
  } catch (error: any) {
    if (error.status) res.status(error.status).json({ error: error.message });
    else throw error;
  }
});

/**
 * POST /api/rutas/:id/despachar — despacho manual inmediato de la primera parada al chofer
 * (por si el operador quiere forzar el despacho antes del cron de las 07:30 AM).
 */
rutasRouter.post('/:id/despachar', requireRol('admin', 'operador'), async (req: Request, res: Response) => {
  const { id: rutaId } = req.params;
  const [ruta] = await query<{ id: string; chofer_id: string }>(
    'SELECT id, chofer_id FROM rutas WHERE id = $1',
    [rutaId],
  );
  if (!ruta) fail('Ruta no encontrada.', 404);
  const ok = await despacharPrimeraParada(ruta.id, ruta.chofer_id);
  res.json({ ok, despachada: ok });
});

/**
 * DELETE /api/rutas/:id — solo si ninguna parada avanzó (`estado <> 'programado'`)
 * ni fue confirmada (`ruta_confirmada_en`). La ruta ya no tiene ciclo de vida:
 * si alguna parada ya se reservó/avisó al chofer, el camino es mover paradas a
 * otra ruta, no borrar.
 */
rutasRouter.delete('/:id', requireRol('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const [ruta] = await query<{ id: string }>('SELECT id FROM rutas WHERE id = $1', [id]);
  if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada.' });
  const [avanzada] = await query(
    `SELECT id FROM viajes
      WHERE ruta_id = $1 AND (estado <> 'programado' OR ruta_confirmada_en IS NOT NULL)
      LIMIT 1`,
    [id],
  );
  if (avanzada) return res.status(409).json({ error: 'Esta ruta ya tiene paradas confirmadas, en curso o completadas; no se puede borrar.' });

  await query(`UPDATE viajes SET ruta_id = NULL, orden = NULL, chofer_id = NULL, patente = NULL WHERE ruta_id = $1`, [id]);
  await query(`DELETE FROM ruta_vaciados WHERE ruta_id = $1`, [id]);
  await query(`DELETE FROM rutas WHERE id = $1`, [id]);
  emitRecursoActualizado('viajes');
  res.json({ ok: true });
});
