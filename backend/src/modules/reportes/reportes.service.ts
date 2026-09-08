import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { query } from '../../config/db';
import { uploadMedia, sendDocument } from '../whatsapp/graphApi';
import { formatearFechaCorta } from '../../services/diasHabiles.service';
import {
  AZUL,
  AZUL_CLARO,
  ROJO,
  GRIS_MUTED,
  LOGO_PATH,
  dibujarEncabezado,
  dibujarTituloSeccion,
  dibujarFila,
  dibujarMontoDestacado,
  dibujarPiePagina,
} from '../../services/pdf.service';

/** Hex de marca (ej. '#152B54') al ARGB de 8 dígitos que espera ExcelJS. */
function argb(hex: string): string {
  return `FF${hex.replace('#', '')}`;
}

/** Genera un Excel (buffer) con el estado actual de los contenedores. */
export async function excelContenedores(): Promise<Buffer> {
  const rows = await query<{ numero: string; estado: string; vence_en: Date | null; actualizado_en: string }>(
    'SELECT numero, estado, vence_en, actualizado_en FROM contenedores ORDER BY numero',
  );
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contenedores');
  ws.columns = [
    { header: 'Número', key: 'numero', width: 20 },
    { header: 'Estado', key: 'estado', width: 16 },
    { header: 'Vence', key: 'vence_en', width: 22 },
    { header: 'Actualizado', key: 'actualizado_en', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

interface MovimientoDetalle {
  fecha: string;
  cliente_telefono: string;
  cliente_nombre: string | null;
  numero_plan: number | null;
  cuenta_corriente_estado: string | null;
  tipo_movimiento: string;
  contenedor_numero: string | null;
  zona: string | null;
  direccion: string | null;
  patente: string | null;
  chofer_nombre: string | null;
  remito: string | null;
  medio_pago: string | null;
  estado_pago: string | null;
  importe: string | null;
  mes: string;
}

/**
 * Todos los movimientos FACTURABLES de los clientes (entregas, recambios,
 * extensiones de retiro), con toda la información necesaria para un reporte
 * contable real: quién es el cliente (nombre + teléfono, no solo un Nº de
 * plan interno), qué se movió, con qué medio de pago y en qué estado. Base
 * de las tres hojas de excelClientes().
 *
 * A pedido se excluye el retiro suelto (v.tipo='retiro' sin grupo_id): es un
 * movimiento logístico real, pero nunca cobra nada aparte (el costo ya se
 * cubrió al entregar) — no aporta nada a un reporte pensado para facturación,
 * así que ni siquiera se trae de la base. El retiro que SÍ es parte de un
 * recambio (grupo_id) se mantiene: ese sí importa para el detalle del
 * movimiento, aunque el importe quede en la pata de 'entrega' del mismo par.
 *
 * Dos fuentes, igual que antes (ver comentario original que esto reemplaza):
 *  1. `viajes` con cliente_telefono — el grueso de los movimientos logísticos.
 *     Se traen SIEMPRE (no solo los ya cobrados): son hechos operativos reales
 *     independientemente de si el pago está validado.
 *  2. `pagos.tipo = 'alargue_retiro'` validados — no generan un `viaje`
 *     propio, así que sin este UNION no aparecerían en ningún lado.
 */
async function movimientosDetalle(mes?: string, telefono?: string): Promise<MovimientoDetalle[]> {
  return query<MovimientoDetalle>(
    `WITH movimientos AS (
       SELECT v.fecha, v.cliente_telefono,
              CASE
                WHEN v.grupo_id IS NOT NULL THEN 'Recambio'
                ELSE 'Entrega'
              END AS tipo_movimiento,
              v.contenedor_numero, v.zona, v.destino_direccion AS direccion,
              v.patente, ch.nombre AS chofer_nombre, v.remito, v.importe,
              CASE
                WHEN v.es_cuenta_corriente THEN 'Cuenta corriente'
                WHEN pg.medio_pago = 'efectivo' THEN 'Efectivo'
                WHEN pg.id IS NOT NULL THEN 'Transferencia'
                ELSE NULL
              END AS medio_pago,
              CASE
                WHEN v.es_cuenta_corriente THEN 'A cuenta corriente'
                WHEN pg.medio_pago = 'efectivo' AND pg.efectivo_cobrado THEN 'Cobrado'
                WHEN pg.medio_pago = 'efectivo' THEN 'Efectivo pendiente de cobrar'
                WHEN pg.estado = 'validado' THEN 'Pagado'
                WHEN pg.estado = 'pendiente' THEN 'Pendiente de validar'
                WHEN pg.estado = 'rechazado' THEN 'Rechazado'
                ELSE NULL
              END AS estado_pago
         FROM viajes v
         LEFT JOIN choferes ch ON ch.id = v.chofer_id
         LEFT JOIN pagos pg ON pg.id = v.pago_id
        WHERE v.cliente_telefono IS NOT NULL
          AND NOT (v.tipo = 'retiro' AND v.grupo_id IS NULL)
          AND ($1::text IS NULL OR to_char(v.fecha, 'YYYY-MM') = $1)
          AND ($2::text IS NULL OR v.cliente_telefono = $2)
        UNION ALL
       SELECT pg.creado_en::date AS fecha, pg.cliente_telefono,
              'Extensión de retiro' AS tipo_movimiento,
              pg.contenedor_numero, NULL::text AS zona, NULL::text AS direccion,
              NULL::text AS patente, NULL::text AS chofer_nombre, NULL::text AS remito, pg.monto AS importe,
              CASE WHEN pg.es_cuenta_corriente THEN 'Cuenta corriente'
                   WHEN pg.medio_pago = 'efectivo' THEN 'Efectivo' ELSE 'Transferencia' END AS medio_pago,
              -- OJO: estado='validado' (filtrado abajo) es "pedido confirmado",
              -- no "plata en mano" — una extensión en efectivo puede estar
              -- validada y todavía sin cobrar (efectivo_cobrado=FALSE). Antes
              -- esto quedaba hardcodeado en 'Pagado' sin mirar ese flag.
              CASE WHEN pg.es_cuenta_corriente THEN 'A cuenta corriente'
                   WHEN pg.medio_pago = 'efectivo' AND pg.efectivo_cobrado THEN 'Cobrado'
                   WHEN pg.medio_pago = 'efectivo' THEN 'Efectivo pendiente de cobrar'
                   ELSE 'Pagado' END AS estado_pago
         FROM pagos pg
        WHERE pg.tipo = 'alargue_retiro' AND pg.estado = 'validado'
          AND ($1::text IS NULL OR to_char(pg.creado_en, 'YYYY-MM') = $1)
          AND ($2::text IS NULL OR pg.cliente_telefono = $2)
     )
     SELECT m.*, COALESCE(cl.nombre, 'Sin nombre') AS cliente_nombre, cl.numero_plan, cl.cuenta_corriente_estado,
            to_char(m.fecha, 'YYYY-MM') AS mes
       FROM movimientos m
       LEFT JOIN clientes cl ON cl.telefono = m.cliente_telefono
      ORDER BY m.fecha, m.cliente_telefono`,
    [mes ?? null, telefono ?? null],
  );
}

interface ResumenMesClientes {
  mes: string;
  cantidad: number;
  entregas: number;
  recambios: number;
  extensiones: number;
  total: number;
  clientesActivos: number;
}

/** Agrupa movimientosDetalle() por mes calendario — para la hoja "Resumen mensual". */
function resumenPorMes(movs: MovimientoDetalle[]): ResumenMesClientes[] {
  const porMes = new Map<string, ResumenMesClientes>();
  for (const m of movs) {
    if (!porMes.has(m.mes)) {
      porMes.set(m.mes, { mes: m.mes, cantidad: 0, entregas: 0, recambios: 0, extensiones: 0, total: 0, clientesActivos: 0 });
    }
    const acc = porMes.get(m.mes)!;
    const importe = m.importe ? Number(m.importe) : 0;
    if (m.tipo_movimiento === 'Entrega') acc.entregas += importe;
    else if (m.tipo_movimiento === 'Recambio') acc.recambios += importe;
    else acc.extensiones += importe;
    acc.total += importe;
    acc.cantidad += 1;
  }
  for (const [mes, acc] of porMes) {
    acc.clientesActivos = new Set(movs.filter((m) => m.mes === mes).map((m) => m.cliente_telefono)).size;
  }
  return [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes));
}

interface ClienteRollup {
  telefono: string;
  nombre: string;
  numero_plan: number | null;
  tipo_cuenta: string;
  cantidad: number;
  total: number;
  ultimo_movimiento: string;
}

const ETIQUETA_CC: Record<string, string> = {
  aprobada: 'Cuenta corriente',
  pendiente: 'Cuenta corriente (pendiente de aprobar)',
  rechazada: 'Ocasional (cta. cte. rechazada)',
  sin_pedir: 'Ocasional',
};

/** Un resumen por cliente (nombre real, no solo Nº de plan) — para la hoja "Clientes". */
function rollupPorCliente(movs: MovimientoDetalle[]): ClienteRollup[] {
  const porCliente = new Map<string, ClienteRollup>();
  for (const m of movs) {
    if (!porCliente.has(m.cliente_telefono)) {
      porCliente.set(m.cliente_telefono, {
        telefono: m.cliente_telefono,
        nombre: m.cliente_nombre ?? 'Sin nombre',
        numero_plan: m.numero_plan,
        tipo_cuenta: ETIQUETA_CC[m.cuenta_corriente_estado ?? 'sin_pedir'] ?? 'Ocasional',
        cantidad: 0,
        total: 0,
        ultimo_movimiento: m.fecha,
      });
    }
    const acc = porCliente.get(m.cliente_telefono)!;
    acc.cantidad += 1;
    acc.total += m.importe ? Number(m.importe) : 0;
    if (m.fecha > acc.ultimo_movimiento) acc.ultimo_movimiento = m.fecha;
  }
  return [...porCliente.values()].sort((a, b) => b.total - a.total);
}

/** Bloque de marca compartido por las hojas de excelClientes: logo + MORATRANS a la izquierda, título a la derecha, barra de acento. */
function dibujarEncabezadoHojaClientes(ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook, ultimaCol: number, titulo: string, subtitulo: string): void {
  ws.getRow(1).height = 46;
  try {
    const imageId = wb.addImage({ filename: LOGO_PATH, extension: 'jpeg' });
    ws.addImage(imageId, { tl: { col: 0.15, row: 0.1 }, ext: { width: 40, height: 40 } });
  } catch {
    // Sin logo disponible, el resto de la planilla sigue igual.
  }
  // Fórmula genérica pensada para tablas anchas — en una tabla angosta (ej.
  // la hoja "Datos del cliente", de solo 2 columnas) `finTitulo` puede
  // terminar igualando o pasando a `ultimaCol`, dejando un rango de merge
  // inválido (inicio > fin) que ExcelJS tira como excepción. Se acota todo a
  // `ultimaCol` y, si no queda lugar para el título de la hoja a la derecha,
  // directamente se omite esa celda (el nombre de la pestaña ya lo dice).
  const finTitulo = Math.max(2, Math.min(ultimaCol, Math.ceil(ultimaCol / 2)));
  ws.mergeCells(1, 2, 1, finTitulo);
  const celdaTitulo = ws.getCell(1, 2);
  celdaTitulo.value = 'MORATRANS';
  celdaTitulo.font = { bold: true, size: 16, color: { argb: argb(AZUL) } };
  celdaTitulo.alignment = { vertical: 'middle' };

  const inicioSubtitulo = Math.min(ultimaCol, finTitulo + 1);
  if (inicioSubtitulo > finTitulo) {
    ws.mergeCells(1, inicioSubtitulo, 1, ultimaCol);
    const celdaSubtitulo = ws.getCell(1, inicioSubtitulo);
    celdaSubtitulo.value = titulo;
    celdaSubtitulo.font = { bold: true, size: 12, color: { argb: argb(ROJO) } };
    celdaSubtitulo.alignment = { vertical: 'middle', horizontal: 'right' };
  }

  const colCorte = Math.round(ultimaCol * 0.7);
  ws.getRow(2).height = 5;
  for (let col = 1; col <= ultimaCol; col++) {
    ws.getCell(2, col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(col <= colCorte ? AZUL : ROJO) } };
  }

  ws.mergeCells(3, 1, 3, ultimaCol);
  const celdaSub = ws.getCell(3, 1);
  celdaSub.value = subtitulo;
  celdaSub.font = { italic: true, size: 9, color: { argb: argb(GRIS_MUTED) } };
}

function dibujarFilaHeaderTablaClientes(ws: ExcelJS.Worksheet, filaNum: number, columnas: { header: string }[]): void {
  const fila = ws.getRow(filaNum);
  columnas.forEach((c, i) => {
    const celda = fila.getCell(i + 1);
    celda.value = c.header;
    celda.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(AZUL) } };
    celda.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  fila.height = 20;
}

function dibujarPieHojaClientes(ws: ExcelJS.Worksheet, ultimaCol: number): void {
  const filaPie = ws.lastRow ? ws.lastRow.number + 2 : 7;
  ws.mergeCells(filaPie, 1, filaPie, ultimaCol);
  const celda = ws.getCell(filaPie, 1);
  celda.value = '¡Gracias por confiar en MoraTrans!';
  celda.font = { size: 9, color: { argb: argb(GRIS_MUTED) } };
  celda.alignment = { horizontal: 'center' };
}

const NOMBRE_MES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/**
 * Genera el Excel (buffer) de clientes: pensado como un reporte contable de
 * verdad, no un volcado de la tabla de viajes. Tres hojas:
 *  1. "Resumen mensual" — cuánto se facturó cada mes, desglosado por tipo de
 *     movimiento, y cuántos clientes tuvieron actividad.
 *  2. "Clientes" (solo si se exportan TODOS los clientes, sin `telefono`) —
 *     un renglón por cliente con su nombre, teléfono, tipo de cuenta,
 *     cantidad de movimientos y total facturado histórico. Si se pide un
 *     cliente puntual, esta hoja se reemplaza por "Datos del cliente" con su
 *     ficha y, si tiene cuenta corriente, el saldo actual.
 *  3. "Pedidos" — el detalle completo, un renglón por movimiento, con
 *     cliente, teléfono, fecha, tipo, contenedor, zona/dirección, patente,
 *     chofer, remito, medio de pago, estado del pago e importe.
 * `telefono` filtra todo a un solo cliente (usado por el botón "Exportar a
 * Excel" del perfil del cliente y por enviarExcelClientePorWhatsApp).
 */
export async function excelClientes(mes?: string, telefono?: string): Promise<Buffer> {
  const movimientos = await movimientosDetalle(mes, telefono);

  let clienteNombre: string | null = null;
  let clienteInfo: { nombre: string; cuenta_corriente_estado: string; numero_plan: number | null } | null = null;
  let saldoCC: Awaited<ReturnType<typeof resumenCuentaCorriente>> | null = null;
  if (telefono) {
    const [cliente] = await query<{ nombre: string; cuenta_corriente_estado: string; numero_plan: number | null }>(
      'SELECT nombre, cuenta_corriente_estado, numero_plan FROM clientes WHERE telefono = $1',
      [telefono],
    );
    clienteInfo = cliente ?? null;
    clienteNombre = cliente?.nombre ?? null;
    if (cliente && (cliente.cuenta_corriente_estado === 'aprobada' || cliente.cuenta_corriente_estado === 'pendiente')) {
      saldoCC = await resumenCuentaCorriente(telefono);
    }
  }
  const tituloCliente = clienteNombre ? clienteNombre.toUpperCase() : 'TODOS LOS CLIENTES';
  const subtitulo = `${mes ? `Mes: ${mes}` : 'Histórico completo'}  ·  Generado: ${new Date().toLocaleString('es-AR')}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MoraTrans';
  wb.created = new Date();

  // ---------- Hoja 1: Resumen mensual ----------
  const resumen = resumenPorMes(movimientos);
  const columnasResumen = [
    { header: 'MES', key: 'mesTexto', width: 16 },
    { header: 'ENTREGAS', key: 'entregas', width: 16 },
    { header: 'RECAMBIOS', key: 'recambios', width: 16 },
    { header: 'EXTENSIONES', key: 'extensiones', width: 16 },
    { header: 'TOTAL FACTURADO', key: 'total', width: 18 },
    { header: 'CANT. MOVIMIENTOS', key: 'cantidad', width: 18 },
    { header: 'CLIENTES ACTIVOS', key: 'clientesActivos', width: 16 },
  ];
  const wsResumen = wb.addWorksheet('Resumen mensual');
  dibujarEncabezadoHojaClientes(wsResumen, wb, columnasResumen.length, `RESUMEN MENSUAL — ${tituloCliente}`, subtitulo);
  wsResumen.columns = columnasResumen.map((c) => ({ key: c.key, width: c.width }));
  dibujarFilaHeaderTablaClientes(wsResumen, 5, columnasResumen);
  wsResumen.views = [{ state: 'frozen', ySplit: 5 }];
  resumen.forEach((r, i) => {
    const [anio, mesNum] = r.mes.split('-');
    const fila = wsResumen.addRow({ ...r, mesTexto: `${NOMBRE_MES[Number(mesNum) - 1]} ${anio}` });
    if (i % 2 === 1) fila.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(AZUL_CLARO) } }));
  });
  if (resumen.length > 0) {
    const filaTotal = wsResumen.addRow({
      mesTexto: 'TOTAL DEL PERÍODO',
      entregas: resumen.reduce((s, r) => s + r.entregas, 0),
      recambios: resumen.reduce((s, r) => s + r.recambios, 0),
      extensiones: resumen.reduce((s, r) => s + r.extensiones, 0),
      total: resumen.reduce((s, r) => s + r.total, 0),
      cantidad: resumen.reduce((s, r) => s + r.cantidad, 0),
      clientesActivos: '—',
    });
    filaTotal.font = { bold: true };
    filaTotal.eachCell((c) => (c.border = { top: { style: 'thin', color: { argb: argb(AZUL) } } }));
  }
  ['entregas', 'recambios', 'extensiones', 'total'].forEach((k) => (wsResumen.getColumn(k).numFmt = '"$"#,##0.00'));
  dibujarPieHojaClientes(wsResumen, columnasResumen.length);

  // ---------- Hoja 2: Clientes (todos) o Datos del cliente (uno puntual) ----------
  if (!telefono) {
    const rollup = rollupPorCliente(movimientos);
    const columnasClientes = [
      { header: 'CLIENTE', key: 'nombre', width: 26 },
      { header: 'TELÉFONO', key: 'telefono', width: 16 },
      { header: 'Nº PLAN', key: 'numero_plan', width: 10 },
      { header: 'TIPO DE CUENTA', key: 'tipo_cuenta', width: 28 },
      { header: 'CANT. MOVIMIENTOS', key: 'cantidad', width: 18 },
      { header: 'TOTAL FACTURADO', key: 'total', width: 18 },
      { header: 'ÚLTIMO MOVIMIENTO', key: 'ultimo_movimiento', width: 18 },
    ];
    const wsClientes = wb.addWorksheet('Clientes');
    dibujarEncabezadoHojaClientes(wsClientes, wb, columnasClientes.length, 'CLIENTES', subtitulo);
    wsClientes.columns = columnasClientes.map((c) => ({ key: c.key, width: c.width }));
    dibujarFilaHeaderTablaClientes(wsClientes, 5, columnasClientes);
    wsClientes.views = [{ state: 'frozen', ySplit: 5 }];
    rollup.forEach((r, i) => {
      const fila = wsClientes.addRow({ ...r, ultimo_movimiento: formatearFechaCortaLocal2(r.ultimo_movimiento) });
      if (i % 2 === 1) fila.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(AZUL_CLARO) } }));
    });
    wsClientes.getColumn('total').numFmt = '"$"#,##0.00';
    dibujarPieHojaClientes(wsClientes, columnasClientes.length);
  } else {
    const columnasDatos = [
      { header: 'CAMPO', key: 'campo', width: 22 },
      { header: 'VALOR', key: 'valor', width: 40 },
    ];
    const wsDatos = wb.addWorksheet('Datos del cliente');
    dibujarEncabezadoHojaClientes(wsDatos, wb, columnasDatos.length, 'DATOS DEL CLIENTE', subtitulo);
    wsDatos.columns = columnasDatos.map((c) => ({ key: c.key, width: c.width }));
    dibujarFilaHeaderTablaClientes(wsDatos, 5, columnasDatos);
    const filasDatos: { campo: string; valor: string }[] = [
      { campo: 'Nombre', valor: clienteInfo?.nombre ?? 'Sin nombre' },
      { campo: 'Teléfono', valor: telefono },
      { campo: 'Nº de plan', valor: clienteInfo?.numero_plan != null ? String(clienteInfo.numero_plan) : '—' },
      { campo: 'Tipo de cuenta', valor: ETIQUETA_CC[clienteInfo?.cuenta_corriente_estado ?? 'sin_pedir'] ?? 'Ocasional' },
      { campo: 'Cantidad de movimientos', valor: String(movimientos.length) },
      { campo: 'Total facturado (histórico)', valor: `$${movimientos.reduce((s, m) => s + (m.importe ? Number(m.importe) : 0), 0).toLocaleString('es-AR')}` },
    ];
    if (saldoCC) {
      filasDatos.push(
        { campo: 'Deuda acumulada (cta. cte.)', valor: `$${saldoCC.totalCargos.toLocaleString('es-AR')}` },
        { campo: 'Pagado a cuenta', valor: `$${saldoCC.totalAbonos.toLocaleString('es-AR')}` },
        { campo: 'Saldo actual', valor: `$${saldoCC.saldo.toLocaleString('es-AR')}` },
      );
    }
    filasDatos.forEach((r, i) => {
      const fila = wsDatos.addRow(r);
      fila.getCell(1).font = { bold: true };
      if (i % 2 === 1) fila.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(AZUL_CLARO) } }));
    });
    dibujarPieHojaClientes(wsDatos, columnasDatos.length);
  }

  // ---------- Hoja 3: Pedidos (detalle) ----------
  const columnasDetalle = [
    ...(telefono ? [] : [{ header: 'CLIENTE', key: 'cliente_nombre', width: 24 }, { header: 'TELÉFONO', key: 'cliente_telefono', width: 16 }]),
    { header: 'FECHA', key: 'fechaTexto', width: 12 },
    { header: 'TIPO', key: 'tipo_movimiento', width: 14 },
    { header: 'CONTENEDOR', key: 'contenedor_numero', width: 14 },
    { header: 'ZONA', key: 'zona', width: 16 },
    { header: 'DIRECCIÓN', key: 'direccion', width: 28 },
    { header: 'PATENTE', key: 'patente', width: 12 },
    { header: 'CHOFER', key: 'chofer_nombre', width: 16 },
    { header: 'Nº REMITO', key: 'remito', width: 12 },
    { header: 'MEDIO DE PAGO', key: 'medio_pago', width: 16 },
    { header: 'ESTADO', key: 'estado_pago', width: 20 },
    { header: 'IMPORTE', key: 'importe', width: 14 },
  ];
  const wsDetalle = wb.addWorksheet('Pedidos');
  dibujarEncabezadoHojaClientes(wsDetalle, wb, columnasDetalle.length, `PEDIDOS — ${tituloCliente}`, `${movimientos.length} movimientos  ·  ${subtitulo}`);
  wsDetalle.columns = columnasDetalle.map((c) => ({ key: c.key, width: c.width }));
  dibujarFilaHeaderTablaClientes(wsDetalle, 5, columnasDetalle);
  wsDetalle.views = [{ state: 'frozen', ySplit: 5 }];
  movimientos.forEach((m, i) => {
    const fila = wsDetalle.addRow({
      ...m,
      fechaTexto: formatearFechaCortaLocal2(m.fecha),
      medio_pago: m.medio_pago ?? '—',
      estado_pago: m.estado_pago ?? '—',
      direccion: m.direccion ?? (m.zona ? `Zona ${m.zona}` : '—'),
      importe: m.importe ? Number(m.importe) : 0,
    });
    if (i % 2 === 1) fila.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(AZUL_CLARO) } }));
  });
  wsDetalle.getColumn('importe').numFmt = '"$"#,##0.00';
  dibujarPieHojaClientes(wsDetalle, columnasDetalle.length);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** "2026-09-06" -> "06/09/2026". Nombre distinto al de reportes.service para no chocar con otros helpers del archivo. */
function formatearFechaCortaLocal2(fechaISO: string): string {
  const [y, m, d] = fechaISO.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Genera el Excel de movimientos de UN cliente (mismo formato que
 * excelClientes) y se lo manda por WhatsApp como documento — lo usa el botón
 * del panel (ver clientes.routes.ts) para exportar el historial completo con
 * detalle logístico (patente, chofer, remito). El cliente por WhatsApp usa
 * en cambio `enviarResumenCuentaCorrientePorWhatsApp`, más simple.
 */
export async function enviarExcelClientePorWhatsApp(telefono: string, mes?: string): Promise<void> {
  const buf = await excelClientes(mes, telefono);
  const mediaId = await uploadMedia(
    buf,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'cuenta-corriente.xlsx',
  );
  await sendDocument(telefono, mediaId, 'cuenta-corriente.xlsx', '📊 Acá tenés el detalle de tus movimientos.');
}

interface ItemCuentaCorriente {
  fecha: string;
  zona: string | null;
  monto: string | null;
}

interface AbonoCuentaCorriente {
  id: string;
  fecha: string;
  monto: string | null;
}

/**
 * Deuda de cuenta corriente de un cliente: cuenta corriente es débito
 * diferido, así que TODO lo entregado a través de ese circuito cuenta como
 * pendiente hasta que el cliente transfiera y un operador lo concilie a
 * mano — no hay hoy un "ya pagado" por pedido, por eso no se filtra por
 * estado de pago. Combina las tres formas en que un cargo llega a ser
 * cuenta corriente:
 *  - Cotizar y elegir "pagar a cuenta corriente" (pago.flow.ts) -> queda en `pedidos`.
 *  - "Pedir contenedor" directo o recambio directo (pedirEntrega.flow.ts,
 *    recambio.flow.ts) -> no generan `pedido`, solo un `viaje` marcado
 *    `es_cuenta_corriente` (ver migración 0033).
 *  - "Alargar retiro" directo (alargarRetiro.flow.ts) -> un `pago` tipo
 *    'alargue_retiro' marcado `es_cuenta_corriente`, sin `pedido` ni `viaje`.
 */
async function itemsCuentaCorriente(telefono: string): Promise<ItemCuentaCorriente[]> {
  return query<ItemCuentaCorriente>(
    `SELECT pe.creado_en::text AS fecha, pe.zona, pe.precio::text AS monto
       FROM pedidos pe
      WHERE pe.cliente_telefono = $1
        AND EXISTS (SELECT 1 FROM pagos pg WHERE pg.pedido_id = pe.id AND pg.es_cuenta_corriente = TRUE)
     UNION ALL
     SELECT v.fecha::text AS fecha, v.zona, v.importe::text AS monto
       FROM viajes v
      WHERE v.cliente_telefono = $1 AND v.es_cuenta_corriente = TRUE
     UNION ALL
     SELECT pg.creado_en::text AS fecha, 'Alargue ' || pg.contenedor_numero AS zona, pg.monto::text AS monto
       FROM pagos pg
      WHERE pg.cliente_telefono = $1 AND pg.tipo = 'alargue_retiro' AND pg.es_cuenta_corriente = TRUE
      ORDER BY fecha`,
    [telefono],
  );
}

/**
 * Abonos ya validados contra el saldo de cuenta corriente (ver
 * registrarAbonoCuentaCorriente en pago.flow.ts): comprobantes que el
 * cliente mandó SIN atarlos a un pedido puntual, porque están pagando su
 * saldo acumulado en vez de un flete específico. El monto lo carga el
 * operador al validar (POST /api/pagos/:id/validar), no el cliente.
 */
async function abonosCuentaCorriente(telefono: string): Promise<AbonoCuentaCorriente[]> {
  return query<AbonoCuentaCorriente>(
    `SELECT id, creado_en::text AS fecha, monto::text AS monto
       FROM pagos
      WHERE cliente_telefono = $1 AND tipo = 'abono_cc' AND estado = 'validado'
      ORDER BY creado_en`,
    [telefono],
  );
}

function sumarMontos(items: { monto: string | null }[]): number {
  return items.reduce((acc, it) => acc + (it.monto ? Number(it.monto) : 0), 0);
}

/**
 * Resumen de cuenta corriente de un cliente: cargos (deuda acumulada, ver
 * itemsCuentaCorriente), abonos ya validados, y el saldo neto = cargos -
 * abonos. Es el "ledger simple" elegido para este circuito: un abono
 * descuenta del total, sin imputarse a qué pedido/viaje puntual cubre (ver
 * comentario de itemsCuentaCorriente). Lo usa tanto el PDF que se manda por
 * WhatsApp (pdfResumenCuentaCorriente) como el resumen del panel (ver
 * GET /api/clientes/:telefono/cuenta-corriente).
 */
export async function resumenCuentaCorriente(telefono: string) {
  const [cargos, abonos] = await Promise.all([itemsCuentaCorriente(telefono), abonosCuentaCorriente(telefono)]);
  const totalCargos = sumarMontos(cargos);
  const totalAbonos = sumarMontos(abonos);
  return { cargos, abonos, totalCargos, totalAbonos, saldo: totalCargos - totalAbonos };
}

/** Solo el número de saldo (ver resumenCuentaCorriente) — para avisos por WhatsApp. */
export async function saldoCuentaCorriente(telefono: string): Promise<number> {
  return (await resumenCuentaCorriente(telefono)).saldo;
}

/** Nombre de archivo seguro: solo letras/números/espacios/guiones, sin extensión. */
function nombreArchivoSeguro(base: string): string {
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos, deja las letras base
    .replace(/[^a-zA-Z0-9 -]/g, '')
    .trim();
}

/**
 * PDF de "Resumen de cuenta" para un cliente de cuenta corriente: mismo
 * encabezado/colores/logo que el ticket de validación de pago (ver
 * dibujarEncabezado en pdf.service.ts) para que ambos documentos se sientan
 * parte de la misma marca. Lista cada pedido/entrega aún no pagado, los
 * abonos ya acreditados, y cierra con el SALDO NETO (deuda - abonos) en un
 * recuadro más grande que el del ticket — es el número que más le importa
 * ver al cliente. Es lo que se pide desde el menú de WhatsApp (ver
 * movimientos.flow.ts). Para pagar, se lo redirige a "Enviar comprobante"
 * (ese flujo sí concilia el pago con un operador; este PDF es solo
 * informativo).
 */
export function pdfResumenCuentaCorriente(
  clienteNombre: string,
  clienteTelefono: string,
  items: ItemCuentaCorriente[],
  abonos: AbonoCuentaCorriente[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = dibujarEncabezado(doc, 'RESUMEN DE CUENTA', [new Date().toLocaleString('es-AR')]);
    y += 25;

    y = dibujarTituloSeccion(doc, y, 'Datos del cliente');
    y = dibujarFila(doc, y, 'Nombre', clienteNombre);
    y = dibujarFila(doc, y, 'Teléfono', clienteTelefono);
    y += 15;

    y = dibujarTituloSeccion(doc, y, 'Pedidos pendientes de pago');
    const totalCargos = sumarMontos(items);
    if (items.length === 0) {
      y = dibujarFila(doc, y, 'Estado', 'No hay pedidos pendientes.');
    } else {
      items.forEach((it) => {
        const monto = it.monto ? Number(it.monto) : 0;
        y = dibujarFila(doc, y, formatearFechaCorta(it.fecha), `${it.zona ?? 'Sin zona'}  —  ${it.monto ? '$' + monto.toLocaleString('es-AR') : 's/monto'}`);
      });
    }
    y += 15;

    y = dibujarTituloSeccion(doc, y, 'Pagos realizados');
    const totalAbonos = sumarMontos(abonos);
    if (abonos.length === 0) {
      y = dibujarFila(doc, y, 'Estado', 'Todavía no registramos ningún pago tuyo.');
    } else {
      abonos.forEach((ab) => {
        const monto = ab.monto ? Number(ab.monto) : 0;
        y = dibujarFila(doc, y, formatearFechaCorta(ab.fecha), `$${monto.toLocaleString('es-AR')}`);
      });
    }
    y += 10;

    dibujarMontoDestacado(doc, y, `$${(totalCargos - totalAbonos).toLocaleString('es-AR')}`, {
      etiqueta: 'SALDO TOTAL',
      fontSize: 28,
      alto: 64,
    });
    dibujarPiePagina(doc, 'Este resumen es informativo. Para pagar, escribí "Enviar comprobante" en el menú.');

    doc.end();
  });
}

/**
 * Genera y manda por WhatsApp el resumen de cuenta corriente de un cliente
 * (ver pdfResumenCuentaCorriente) — lo dispara el propio cliente desde el
 * menú "📊 Resumen de cuenta" (movimientos.flow.ts).
 */
export async function enviarResumenCuentaCorrientePorWhatsApp(telefono: string, clienteNombre: string | null): Promise<void> {
  const { cargos, abonos } = await resumenCuentaCorriente(telefono);
  const nombre = clienteNombre ?? 'Cliente';
  const buf = await pdfResumenCuentaCorriente(nombre, telefono, cargos, abonos);
  const nombreArchivo = `MORATRANS CUENTA CORRIENTE - ${nombreArchivoSeguro(nombre)}.pdf`;
  const mediaId = await uploadMedia(buf, 'application/pdf', nombreArchivo);
  await sendDocument(
    telefono,
    mediaId,
    nombreArchivo,
    '📊 Acá tenés tu resumen de cuenta.\n\n_Para pagar, escribí *Enviar comprobante* en el menú._',
  );
}

/**
 * Genera un PDF (buffer) con un resumen de pagos.
 * `verComprobante` controla, según el rol, si se listan las referencias sensibles.
 */
export function pdfResumenPagos(
  pagos: { cliente_telefono: string; estado: string; monto: string | null; creado_en: string }[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Resumen de pagos', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).fillColor('#555').text(`Generado: ${new Date().toLocaleString('es-AR')}`);
    doc.moveDown();

    doc.fillColor('#000').fontSize(11);
    pagos.forEach((p) => {
      doc.text(
        `${new Date(p.creado_en).toLocaleDateString('es-AR')}  ·  ${p.cliente_telefono}  ·  ` +
          `${p.estado}  ·  ${p.monto ? '$' + p.monto : 's/monto'}`,
      );
    });
    if (pagos.length === 0) doc.text('Sin pagos en el período.');
    doc.end();
  });
}
