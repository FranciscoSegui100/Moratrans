/**
 * Carga masiva de datos de prueba (clientes, choferes, contenedores,
 * pedidos, pagos, viajes, rutas, alertas, conversaciones) para probar el
 * panel de punta a punta con volumen realista antes de producción.
 *
 * SOLO pensado para correr contra una base de pruebas (branch/proyecto
 * separado de producción) — no valida ni bloquea nada, inserta directo.
 *
 * Uso:  npm run db:seed-masivo
 */
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { pool, query } from '../config/db';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickWeighted<T>(options: [T, number][]): T {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [val, w] of options) {
    if (r < w) return val;
    r -= w;
  }
  return options[options.length - 1][0];
}
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}
function fechaSql(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function insertMany<T extends Record<string, any>>(
  table: string,
  columns: string[],
  rows: T[],
  returning?: string,
  onConflict?: string,
): Promise<any[]> {
  if (!rows.length) return [];
  const out: any[] = [];
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: any[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((c) => {
        values.push(row[c]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(',')})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}${
      onConflict ? ` ${onConflict}` : ''
    }${returning ? ` RETURNING ${returning}` : ''}`;
    const res = await pool.query(sql, values);
    if (returning) out.push(...res.rows);
  }
  return out;
}

// ---------------------------------------------------------------------
// Datos de referencia (sabor argentino / Gran Mendoza)
// ---------------------------------------------------------------------
const NOMBRES = [
  'Juan', 'Carlos', 'Miguel', 'Jorge', 'Luis', 'Diego', 'Martín', 'Pablo', 'Sergio', 'Ricardo',
  'Gustavo', 'Fernando', 'Daniel', 'Alejandro', 'Roberto', 'Marcelo', 'Gabriel', 'Hernán', 'Nicolás', 'Facundo',
  'María', 'Ana', 'Laura', 'Patricia', 'Claudia', 'Silvia', 'Mónica', 'Gabriela', 'Valeria', 'Carolina',
  'Lucía', 'Sofía', 'Camila', 'Florencia', 'Agustina', 'Rosa', 'Marta', 'Elena', 'Susana', 'Graciela',
];
const APELLIDOS = [
  'González', 'Rodríguez', 'Fernández', 'López', 'Martínez', 'Pérez', 'García', 'Sánchez', 'Romero', 'Díaz',
  'Álvarez', 'Torres', 'Ruiz', 'Ramírez', 'Flores', 'Benítez', 'Acosta', 'Medina', 'Herrera', 'Suárez',
  'Castro', 'Ortiz', 'Molina', 'Silva', 'Rojas', 'Núñez', 'Giménez', 'Aguirre', 'Vega', 'Luna',
];
const EMPRESAS = [
  'Bodega del Sur SRL', 'Corralón Mendoza', 'Ferretería Andina', 'Obras San Rafael SA', 'Distribuidora Cuyo',
  'Supermercado Oeste', 'Constructora Los Andes', 'Vivero El Parral', 'Transportes Cuyanos SA', 'Depósito Rivadavia',
  'Agro Insumos Maipú', 'Textil Guaymallén', 'Metalúrgica Las Heras', 'Hortícola San Martín', 'Bodega Coquimbito',
];
const CALLES = [
  'San Martín', 'Las Heras', 'Belgrano', 'Mitre', 'Colón', 'Rivadavia', 'Chile', 'España', 'Perú', '9 de Julio',
  'Paso de los Andes', 'Boulogne Sur Mer', 'Lavalle', 'Garibaldi', 'Alem', 'Juan B. Justo', 'Emilio Civit', 'Montevideo',
];
const DEPARTAMENTOS: { nombre: string; precio: number }[] = [
  { nombre: 'Capital', precio: 8000 },
  { nombre: 'Godoy Cruz', precio: 8500 },
  { nombre: 'Guaymallén', precio: 9000 },
  { nombre: 'Las Heras', precio: 9500 },
  { nombre: 'Luján de Cuyo', precio: 11000 },
  { nombre: 'Maipú', precio: 10000 },
  { nombre: 'San Rafael', precio: 18000 },
  { nombre: 'Rivadavia', precio: 12500 },
];
// "000" no es un código de área argentino real (ver NDC_AR_3 en
// telefono.service.ts): ningún WhatsApp real puede corresponder a estos
// números. A propósito, para datos de prueba que puedan terminar en una
// base conectada al bot real — ver alertas.cron.ts, que manda WhatsApp real
// de forma proactiva a contenedores por vencer sin pasar por el interruptor
// "Desactivar bot".
const PREFIJOS_AREA = ['000'];

function telefonoUnico(usados: Set<string>): string {
  let t: string;
  do {
    const area = pick(PREFIJOS_AREA);
    const abonado = String(randInt(1000000, 9999999)).padStart(7, '0');
    t = `549${area}${abonado}`;
  } while (usados.has(t));
  usados.add(t);
  return t;
}

function patente(): string {
  // Mezcla de formato viejo (ABC123) y nuevo (AB123CD).
  const letras = () => String.fromCharCode(65 + randInt(0, 25));
  if (Math.random() < 0.5) {
    return `${letras()}${letras()}${letras()}${randInt(100, 999)}`;
  }
  return `${letras()}${letras()}${randInt(100, 999)}${letras()}${letras()}`;
}

function numeroContenedor(usados: Set<string>): string {
  const prefijos = ['MTRU', 'MSKU', 'TCLU', 'CMAU', 'HLXU', 'OOLU'];
  let n: string;
  do {
    n = `${pick(prefijos)}${String(randInt(1, 9999999)).padStart(7, '0')}`;
  } while (usados.has(n));
  usados.add(n);
  return n;
}

async function main() {
  console.log('🌱 Carga masiva de datos de prueba — arrancando...\n');

  // -------------------------------------------------------------
  // 1. Tarifas (ON CONFLICT: puede correr sobre una base que ya tenga
  //    algunos de estos departamentos cargados de antes)
  // -------------------------------------------------------------
  await insertMany(
    'tarifas_departamento',
    ['departamento', 'precio', 'activo', 'prioridad'],
    DEPARTAMENTOS.map((d, i) => ({ departamento: d.nombre, precio: d.precio, activo: true, prioridad: i })),
    undefined,
    'ON CONFLICT (departamento) DO NOTHING',
  );
  console.log(`✔ tarifas_departamento: ${DEPARTAMENTOS.length}`);

  // -------------------------------------------------------------
  // 2. Usuarios del panel (todos con contraseña Moratrans2026!)
  // -------------------------------------------------------------
  // El admin real (admin@empresa.com) ya existe en cualquier base que haya
  // corrido seed.sql — se reutiliza en vez de intentar re-crearlo.
  const [adminExistente] = await query<{ id: string }>(
    `SELECT id FROM usuarios WHERE rol = 'admin' ORDER BY creado_en LIMIT 1`,
  );
  let adminId = adminExistente?.id as string | undefined;
  const hash = await bcrypt.hash('Moratrans2026!', 10);
  const usuariosNuevosSeed = [
    { nombre: 'Operador Prueba', email: 'operador@empresa.com', rol: 'operador' },
    { nombre: 'Finanzas Prueba', email: 'finanzas@empresa.com', rol: 'finanzas' },
    { nombre: 'Lectura Prueba', email: 'lectura@empresa.com', rol: 'lectura' },
    ...(adminId ? [] : [{ nombre: 'Administrador', email: 'admin@empresa.com', rol: 'admin' }]),
  ];
  const usuariosCreados = await insertMany(
    'usuarios',
    ['nombre', 'email', 'password_hash', 'rol'],
    usuariosNuevosSeed.map((u) => ({ ...u, password_hash: hash })),
    'id, rol',
    'ON CONFLICT (email) DO NOTHING',
  );
  if (!adminId) adminId = usuariosCreados.find((u) => u.rol === 'admin')?.id as string;
  const operadorId: string =
    usuariosCreados.find((u) => u.rol === 'operador')?.id ??
    (await query<{ id: string }>(`SELECT id FROM usuarios WHERE email = 'operador@empresa.com'`))[0]?.id;
  console.log(`✔ usuarios: ${usuariosCreados.length} nuevos (login admin ya existente reutilizado: admin@empresa.com)`);

  // -------------------------------------------------------------
  // 3. Choferes
  // -------------------------------------------------------------
  const telefonosUsados = new Set<string>();
  const NUM_CHOFERES = 15;
  const choferesSeed = Array.from({ length: NUM_CHOFERES }, (_, i) => ({
    nombre: `${pick(NOMBRES)} ${pick(APELLIDOS)}`,
    telefono: telefonoUnico(telefonosUsados),
    patente: patente(),
    activo: i < 13,
    desactivado_en: i >= 13 ? new Date() : null,
  }));
  const choferes = await insertMany(
    'choferes',
    ['nombre', 'telefono', 'patente', 'activo', 'desactivado_en'],
    choferesSeed,
    'id, activo, patente',
  );
  const choferesActivos = choferes.filter((c) => c.activo);
  console.log(`✔ choferes: ${choferes.length} (${choferesActivos.length} activos)`);

  // -------------------------------------------------------------
  // 4. Clientes
  // -------------------------------------------------------------
  const NUM_CLIENTES = 100;
  // Arranca bien por encima del máximo existente para no chocar con
  // numeraciones reales ya cargadas (ej. importadas del Excel viejo).
  const [{ max_plan }] = await query<{ max_plan: number }>(
    `SELECT COALESCE(MAX(numero_plan), 0)::int AS max_plan FROM clientes`,
  );
  let numeroPlanSeq = max_plan + 1000;
  const clientesSeed = Array.from({ length: NUM_CLIENTES }, (_, i) => {
    const esEmpresa = Math.random() < 0.18;
    const nombre = esEmpresa ? pick(EMPRESAS) : `${pick(NOMBRES)} ${pick(APELLIDOS)}`;
    const dep = pick(DEPARTAMENTOS);
    const direccion = `${pick(CALLES)} ${randInt(100, 4500)}, ${dep.nombre}`;
    const ccEstado = pickWeighted<'sin_pedir' | 'pendiente' | 'aprobada' | 'rechazada'>([
      ['sin_pedir', 70],
      ['pendiente', 10],
      ['aprobada', 15],
      ['rechazada', 5],
    ]);
    return {
      nombre,
      telefono: telefonoUnico(telefonosUsados),
      direccion,
      cuenta_corriente_estado: ccEstado,
      numero_plan: Math.random() < 0.4 ? numeroPlanSeq++ : null,
      _dep: dep.nombre,
    };
  });
  const clientes = await insertMany(
    'clientes',
    ['nombre', 'telefono', 'direccion', 'cuenta_corriente_estado', 'numero_plan'],
    clientesSeed,
    'id, telefono, nombre, direccion',
  );
  // Reasociar el departamento generado (no vuelve del INSERT) por índice.
  const clientesConDep = clientes.map((c, i) => ({ ...c, dep: clientesSeed[i]._dep }));
  console.log(`✔ clientes: ${clientes.length}`);

  // -------------------------------------------------------------
  // 5. Ubicaciones (depósitos / vaciaderos)
  // -------------------------------------------------------------
  const ubicacionesSeed = [
    { tipo: 'deposito', nombre: 'Depósito Guaymallén', direccion: 'Acceso Este 4500, Guaymallén', lat: -32.8908, lng: -68.787 },
    { tipo: 'deposito', nombre: 'Depósito Maipú', direccion: 'RP50 km 8, Maipú', lat: -32.9833, lng: -68.7833 },
    { tipo: 'vaciadero', nombre: 'Vaciadero Las Heras', direccion: 'Panamericana 2100, Las Heras', lat: -32.8333, lng: -68.8333 },
    { tipo: 'vaciadero', nombre: 'Vaciadero Luján', direccion: 'RN40 km 12, Luján de Cuyo', lat: -33.0333, lng: -68.8667 },
  ];
  const ubicaciones = await insertMany(
    'ubicaciones',
    ['tipo', 'nombre', 'direccion', 'lat', 'lng'],
    ubicacionesSeed,
    'id, tipo, nombre, direccion',
  );
  const depositos = ubicaciones.filter((u) => u.tipo === 'deposito');
  const vaciaderos = ubicaciones.filter((u) => u.tipo === 'vaciadero');
  console.log(`✔ ubicaciones: ${ubicaciones.length}`);

  // -------------------------------------------------------------
  // 6. Contenedores
  // -------------------------------------------------------------
  const contenedoresUsados = new Set<string>();
  const NUM_CONTENEDORES = 180;
  const contenedoresSeed = Array.from({ length: NUM_CONTENEDORES }, () => {
    const estado = pickWeighted<'disponible' | 'reservado' | 'entregado' | 'retirado' | 'mantenimiento'>([
      ['disponible', 35],
      ['reservado', 10],
      ['entregado', 30],
      ['retirado', 20],
      ['mantenimiento', 5],
    ]);
    const tamano = pick([5, 7, 9]);
    const cliente = ['reservado', 'entregado'].includes(estado) || (estado === 'retirado' && Math.random() < 0.6)
      ? pick(clientes)
      : null;
    let vence_en: Date | null = null;
    if (estado === 'entregado') vence_en = daysFromNow(randInt(-8, 25));
    else if (estado === 'reservado') vence_en = daysFromNow(randInt(5, 30));
    const chofer = pick(choferesActivos);
    const actualizado_por = ['entregado', 'retirado'].includes(estado) ? `chofer:${chofer.id}` : `admin:${adminId}`;
    return {
      numero: numeroContenedor(contenedoresUsados),
      estado,
      tamano,
      cliente_id: cliente?.id ?? null,
      vence_en,
      actualizado_por,
    };
  });
  const contenedores = await insertMany(
    'contenedores',
    ['numero', 'estado', 'tamano', 'cliente_id', 'vence_en', 'actualizado_por'],
    contenedoresSeed,
    'numero, estado, cliente_id',
    'ON CONFLICT (numero) DO NOTHING',
  );
  console.log(`✔ contenedores: ${contenedores.length} (de ${contenedoresSeed.length} intentados — el resto ya existía)`);
  const poolAsignables = shuffle(contenedores.filter((c) => ['reservado', 'entregado', 'retirado'].includes(c.estado)));
  let poolIdx = 0;
  const siguienteContenedorAsignable = () => (poolIdx < poolAsignables.length ? poolAsignables[poolIdx++] : null);

  // -------------------------------------------------------------
  // 7. Pedidos
  // -------------------------------------------------------------
  const NUM_PEDIDOS = 130;
  const pedidosSeed = Array.from({ length: NUM_PEDIDOS }, () => {
    const cliente = pick(clientesConDep);
    const dep = DEPARTAMENTOS.find((d) => d.nombre === cliente.dep)!;
    const estado = pickWeighted<
      'nuevo' | 'cotizado' | 'confirmado' | 'en_proceso' | 'completado' | 'cancelado' | 'fuera_de_zona'
    >([
      ['nuevo', 10],
      ['cotizado', 15],
      ['confirmado', 20],
      ['en_proceso', 10],
      ['completado', 38],
      ['cancelado', 4],
      ['fuera_de_zona', 3],
    ]);
    const tieneCotizacion = !['nuevo', 'fuera_de_zona'].includes(estado);
    const creado_en = daysFromNow(-randInt(1, 75));
    const fecha_entrega = estado === 'completado' ? daysFromNow(-randInt(1, 60)) : daysFromNow(randInt(-2, 20));
    return {
      cliente_telefono: cliente.telefono,
      cliente_nombre: cliente.nombre,
      zona: cliente.dep,
      precio: tieneCotizacion ? dep.precio : null,
      fecha_aproximada: fechaSql(fecha_entrega),
      destino_direccion: cliente.direccion,
      horario_preferido: pick(['🌅 Mañana (8 a 12hs)', '🌇 Tarde (12 a 18hs)', null]),
      estado,
      fecha_entrega: tieneCotizacion ? fechaSql(fecha_entrega) : null,
      fecha_retiro_estimada: tieneCotizacion ? fechaSql(daysFromNow(7)) : null,
      direccion_verificada: Math.random() < 0.85,
      creado_en,
    };
  });
  const pedidos = await insertMany(
    'pedidos',
    [
      'cliente_telefono', 'cliente_nombre', 'zona', 'precio', 'fecha_aproximada', 'destino_direccion',
      'horario_preferido', 'estado', 'fecha_entrega', 'fecha_retiro_estimada', 'direccion_verificada', 'creado_en',
    ],
    pedidosSeed,
    'id, cliente_telefono, estado, precio, creado_en',
  );
  console.log(`✔ pedidos: ${pedidos.length}`);

  // -------------------------------------------------------------
  // 8. Pagos (+ tickets + viajes para pedidos pagos)
  // -------------------------------------------------------------
  const pagosSeed: Record<string, any>[] = [];
  const pedidoAContenedor = new Map<string, string>();
  for (const p of pedidos) {
    const estaPagable = ['confirmado', 'en_proceso', 'completado'].includes(p.estado);
    const cotizadoConPagoPendiente = p.estado === 'cotizado' && Math.random() < 0.5;
    if (!estaPagable && !cotizadoConPagoPendiente) continue;

    const medio_pago = pickWeighted<'transferencia' | 'efectivo'>([
      ['transferencia', 75],
      ['efectivo', 25],
    ]);
    const estadoPago = estaPagable ? 'validado' : 'pendiente';
    const efectivo_cobrado = medio_pago === 'efectivo' ? (estaPagable ? Math.random() < 0.8 : false) : false;

    let contenedorNum: string | null = null;
    if (estaPagable) {
      const c = siguienteContenedorAsignable();
      if (c) {
        contenedorNum = c.numero;
        pedidoAContenedor.set(p.id, c.numero);
      }
    }

    pagosSeed.push({
      cliente_telefono: p.cliente_telefono,
      pedido_id: p.id,
      monto: p.precio,
      titular_transferencia: medio_pago === 'transferencia' ? p.cliente_telefono : null,
      es_cuenta_corriente: false,
      tipo: 'flete',
      medio_pago,
      efectivo_cobrado,
      estado: estadoPago,
      validado_por: estaPagable ? adminId : null,
      creado_en: new Date(new Date(p.creado_en).getTime() + 1000 * 60 * randInt(10, 600)),
      _contenedor: contenedorNum,
      _pedidoEstado: p.estado,
    });
  }
  // Variedad: algunos abonos de cuenta corriente y alargues sueltos.
  const clientesCC = clientes.filter((_, i) => clientesSeed[i].cuenta_corriente_estado === 'aprobada');
  for (let i = 0; i < 12 && clientesCC.length; i++) {
    const cl = pick(clientesCC);
    pagosSeed.push({
      cliente_telefono: cl.telefono,
      pedido_id: null,
      monto: pick([5000, 8000, 12000, 15000, 20000]),
      titular_transferencia: cl.nombre,
      es_cuenta_corriente: true,
      tipo: 'abono_cc',
      medio_pago: 'transferencia',
      efectivo_cobrado: false,
      estado: pickWeighted([['validado', 80], ['pendiente', 20]]),
      validado_por: adminId,
      creado_en: daysFromNow(-randInt(1, 40)),
      _contenedor: null,
      _pedidoEstado: null,
    });
  }

  const pagos = await insertMany(
    'pagos',
    [
      'cliente_telefono', 'pedido_id', 'monto', 'titular_transferencia', 'es_cuenta_corriente', 'tipo',
      'medio_pago', 'efectivo_cobrado', 'estado', 'validado_por', 'creado_en',
    ],
    pagosSeed,
    'id, pedido_id, estado, cliente_telefono, monto, creado_en',
  );
  console.log(`✔ pagos: ${pagos.length}`);

  // tickets para pagos validados con pedido+contenedor asignado
  const ticketsSeed: Record<string, any>[] = [];
  const viajesSeed: Record<string, any>[] = [];
  for (let i = 0; i < pagos.length; i++) {
    const pago = pagos[i];
    const seed = pagosSeed[i];
    if (!seed._contenedor || pago.estado !== 'validado') continue;
    const cerrado = seed._pedidoEstado === 'completado';
    ticketsSeed.push({
      pedido_id: pago.pedido_id,
      pago_id: pago.id,
      contenedor_numero: seed._contenedor,
      estado: cerrado ? 'cerrado' : 'activo',
      cerrado_en: cerrado ? daysFromNow(-randInt(0, 5)) : null,
      creado_en: pago.creado_en,
    });

    const chofer = pick(choferesActivos);
    const pedidoOrig = pedidos.find((p) => p.id === pago.pedido_id)!;
    let estadoViaje: string;
    let fechaViaje: Date;
    if (seed._pedidoEstado === 'completado') {
      estadoViaje = 'completado';
      fechaViaje = daysFromNow(-randInt(1, 55));
    } else if (seed._pedidoEstado === 'en_proceso') {
      estadoViaje = 'en_curso';
      fechaViaje = daysFromNow(randInt(-1, 1));
    } else {
      estadoViaje = 'programado';
      fechaViaje = daysFromNow(randInt(0, 15));
    }
    const deposito = pick(depositos);
    viajesSeed.push({
      tipo: 'entrega',
      fecha: fechaSql(fechaViaje),
      chofer_id: chofer.id,
      contenedor_numero: seed._contenedor,
      cliente_telefono: pago.cliente_telefono,
      patente: chofer.patente,
      zona: pedidoOrig.zona,
      destino_direccion: pedidoOrig.destino_direccion,
      horario_preferido: pedidoOrig.horario_preferido,
      ubicacion_id: deposito.id,
      ubicacion_direccion: deposito.direccion,
      direccion_verificada: true,
      estado: estadoViaje,
      pago_id: pago.id,
      creado_en: pago.creado_en,
    });

    // Retiro ya completado para una parte de los contenedores "retirado"/completados.
    if (seed._pedidoEstado === 'completado' && Math.random() < 0.55) {
      const vaciadero = pick(vaciaderos);
      const choferRetiro = pick(choferesActivos);
      viajesSeed.push({
        tipo: 'retiro',
        fecha: fechaSql(daysFromNow(-randInt(0, 10))),
        chofer_id: choferRetiro.id,
        contenedor_numero: seed._contenedor,
        cliente_telefono: pago.cliente_telefono,
        patente: choferRetiro.patente,
        zona: pedidoOrig.zona,
        destino_direccion: pedidoOrig.destino_direccion,
        horario_preferido: null,
        ubicacion_id: vaciadero.id,
        ubicacion_direccion: vaciadero.direccion,
        direccion_verificada: true,
        estado: 'completado',
        pago_id: null,
        creado_en: pago.creado_en,
      });
    }
  }
  await insertMany(
    'tickets',
    ['pedido_id', 'pago_id', 'contenedor_numero', 'estado', 'cerrado_en', 'creado_en'],
    ticketsSeed,
  );
  console.log(`✔ tickets: ${ticketsSeed.length}`);

  const viajesCreados = await insertMany(
    'viajes',
    [
      'tipo', 'fecha', 'chofer_id', 'contenedor_numero', 'cliente_telefono', 'patente', 'zona',
      'destino_direccion', 'horario_preferido', 'ubicacion_id', 'ubicacion_direccion', 'direccion_verificada',
      'estado', 'pago_id', 'creado_en',
    ],
    viajesSeed,
    'id, fecha, chofer_id, estado, tipo',
  );
  console.log(`✔ viajes: ${viajesCreados.length}`);

  // -------------------------------------------------------------
  // 9. Rutas — agrupa algunos viajes "programado" de los próximos días
  // -------------------------------------------------------------
  const programados = viajesCreados.filter((v) => v.estado === 'programado');
  const porFechaChofer = new Map<string, typeof programados>();
  for (const v of programados) {
    const key = `${v.fecha}|${v.chofer_id}`;
    if (!porFechaChofer.has(key)) porFechaChofer.set(key, []);
    porFechaChofer.get(key)!.push(v);
  }
  let rutasCreadas = 0;
  let paradasCreadas = 0;
  for (const [key, viajesGrupo] of porFechaChofer) {
    if (rutasCreadas >= 10) break;
    const [fecha, choferId] = key.split('|');
    const [ruta] = await insertMany(
      'rutas',
      ['fecha', 'chofer_id', 'patente', 'armada_por'],
      [{ fecha, chofer_id: choferId, patente: choferes.find((c) => c.id === choferId)?.patente ?? null, armada_por: adminId }],
      'id',
    );
    rutasCreadas++;
    let orden = 1;
    for (const v of viajesGrupo.slice(0, 6)) {
      await pool.query(`UPDATE viajes SET ruta_id = $1, orden = $2 WHERE id = $3`, [ruta.id, orden, v.id]);
      orden++;
      paradasCreadas++;
    }
  }
  console.log(`✔ rutas: ${rutasCreadas} (${paradasCreadas} paradas asignadas)`);

  // -------------------------------------------------------------
  // 10. Alertas
  // -------------------------------------------------------------
  const alertasSeed: Record<string, any>[] = [];
  // Pagos pendientes de validar.
  for (const p of pagos.filter((x) => x.estado === 'pendiente').slice(0, 20)) {
    alertasSeed.push({
      tipo: 'pago_pendiente_validacion',
      referencia_id: p.id,
      mensaje: `${p.cliente_telefono} envió el comprobante de su pedido`,
      estado: 'nueva',
      creado_en: p.creado_en,
    });
  }
  // Contenedores por vencer (entregado, vence pronto).
  for (const c of contenedores.filter((x) => x.estado === 'entregado').slice(0, 15)) {
    alertasSeed.push({
      tipo: 'contenedor_por_vencer',
      referencia_id: c.numero,
      mensaje: `El contenedor ${c.numero} vence pronto`,
      estado: pickWeighted([['nueva', 60], ['vista', 40]]),
      creado_en: daysFromNow(-randInt(0, 3)),
    });
  }
  // Clientes pidiendo asesor (quedan "Requiere vos" en Conversaciones).
  const clientesAsesor = shuffle(clientes).slice(0, 8);
  for (const cl of clientesAsesor) {
    alertasSeed.push({
      tipo: 'solicita_asesor',
      referencia_id: cl.telefono,
      mensaje: `${cl.telefono} pidió hablar con un asesor`,
      estado: 'nueva',
      creado_en: daysFromNow(-randInt(0, 2)),
    });
  }
  await insertMany(
    'alertas',
    ['tipo', 'referencia_id', 'mensaje', 'estado', 'creado_en'],
    alertasSeed,
    undefined,
    "ON CONFLICT (tipo, referencia_id) WHERE estado <> 'resuelta' DO NOTHING",
  );
  console.log(`✔ alertas: ${alertasSeed.length}`);

  // -------------------------------------------------------------
  // 11. Conversaciones (mensajes_chat) — hilos cortos para ~35 clientes
  // -------------------------------------------------------------
  const clientesConChat = shuffle(clientes).slice(0, 35);
  const mensajesSeed: Record<string, any>[] = [];
  const guiones = [
    ['Hola! Quería saber el precio de un contenedor', '¡Hola! Para cotizarte necesito saber tu dirección 📍', 'Es en {dir}', 'Perfecto, el precio para esa zona es ${precio} ✅'],
    ['Buenas, necesito un contenedor para una mudanza', '¡Hola! ¿Me pasás la dirección de entrega?', '{dir}', 'Dale, te paso los datos para transferir'],
    ['Ya pagué, les mando el comprobante', 'Perfecto, lo reviso y te confirmo 🙏', null, null],
    ['Hola, ¿cuándo me lo retiran?', 'Dejame confirmar con el chofer y te aviso', null, null],
  ];
  for (const cl of clientesConChat) {
    const guion = pick(guiones);
    let t = daysFromNow(-randInt(0, 10)).getTime();
    const dep = pick(DEPARTAMENTOS);
    for (let i = 0; i < guion.length; i++) {
      const texto = guion[i];
      if (!texto) continue;
      const origen = i % 2 === 0 ? 'cliente' : 'bot';
      t += 1000 * 60 * randInt(1, 15);
      mensajesSeed.push({
        telefono: cl.telefono,
        origen,
        texto: texto.replace('{dir}', cl.direccion).replace('{precio}', String(dep.precio)),
        usuario_id: null,
        creado_en: new Date(t),
      });
    }
    // Algunos terminan con un operador respondiendo (simula conversación tomada).
    if (Math.random() < 0.3) {
      t += 1000 * 60 * randInt(1, 20);
      mensajesSeed.push({
        telefono: cl.telefono,
        origen: 'operador',
        texto: 'Hola, te escribo del equipo de Moratrans — ¿en qué te puedo ayudar?',
        usuario_id: operadorId,
        creado_en: new Date(t),
      });
    }
  }
  await insertMany('mensajes_chat', ['telefono', 'origen', 'texto', 'usuario_id', 'creado_en'], mensajesSeed);
  console.log(`✔ mensajes_chat: ${mensajesSeed.length} (${clientesConChat.length} conversaciones)`);

  // Sesiones "modoHumano" para los clientes con alerta de asesor, para que
  // Conversaciones los muestre como "Requiere vos".
  for (const cl of clientesAsesor) {
    await pool.query(
      `INSERT INTO sesiones_chat (telefono, contexto) VALUES ($1, $2)
       ON CONFLICT (telefono) DO UPDATE SET contexto = $2`,
      [cl.telefono, JSON.stringify({ modoHumano: true, asesorCount: 2 })],
    );
    // Asegura que también aparezcan en la lista de Conversaciones (requiere
    // al menos un mensaje en mensajes_chat).
    await pool.query(
      `INSERT INTO mensajes_chat (telefono, origen, texto, creado_en) VALUES ($1, 'cliente', 'Hola, necesito hablar con alguien por favor', now())`,
      [cl.telefono],
    );
  }
  console.log(`✔ sesiones "Requiere vos": ${clientesAsesor.length}`);

  console.log('\n🌱 Carga masiva completa.');
  console.log(`   Login panel: admin@empresa.com / Moratrans2026!`);
  await pool.end();
}

main().catch((e) => {
  console.error('❌ Error en la carga masiva:', e);
  process.exit(1);
});
