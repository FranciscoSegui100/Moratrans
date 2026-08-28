import ExcelJS from 'exceljs';
import { query } from '../../config/db';
import { AZUL, AZUL_CLARO, ROJO, GRIS_MUTED, LOGO_PATH } from '../../services/pdf.service';

/** Hex de marca (ej. '#152B54') al ARGB de 8 dígitos que espera ExcelJS. Mismo helper que reportes.service.ts. */
function argb(hex: string): string {
  return `FF${hex.replace('#', '')}`;
}

export interface MovimientoIngreso {
  fecha: string;
  numero_pedido: number | null;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  contenedor_numero: string | null;
  zona: string | null;
  categoria: 'Entrega' | 'Recambio' | 'Alargue de retiro';
  medio_pago: 'Transferencia' | 'Cuenta corriente';
  importe: number;
}

/**
 * Ingresos = ventas nuevas confirmadas (no cobranzas de deuda ya reconocida).
 * Dos fuentes, sin superponerse:
 *  1. `pagos` validados de tipo 'flete'/'alargue_retiro' — cubre tanto lo
 *     pagado por transferencia como lo confirmado a cuenta corriente vía
 *     cotización (pago.flow.ts::iniciarCuentaCorriente ya pasa por acá): es
 *     la confirmación de una venta nueva, no el cobro de saldo viejo.
 *  2. `viajes` con es_cuenta_corriente=TRUE (entrega directa o recambio para
 *     un cliente ya aprobado, ver pedirEntrega.flow.ts/recambio.flow.ts):
 *     estos NUNCA pasan por `pagos` — sin esta segunda fuente, esas ventas
 *     no aparecerían en ningún lado de este reporte. Solo la pata 'entrega'
 *     lleva el importe (ver comentario en recambio.flow.ts), así que no filtrar
 *     por 'retiro' evita contar el recambio dos veces.
 * A propósito se EXCLUYE `pagos.tipo = 'abono_cc'`: es el cliente saldando
 * deuda de cuenta corriente ya reconocida como ingreso en el momento de la
 * entrega (fuente 2) — contarlo de nuevo acá duplicaría esa venta.
 */
async function movimientosIngreso(anio: number): Promise<MovimientoIngreso[]> {
  return query<MovimientoIngreso>(
    `WITH ingresos AS (
       SELECT p.creado_en::date AS fecha, p.monto::numeric AS importe, p.pedido_id, p.contenedor_numero,
              p.cliente_telefono, p.es_cuenta_corriente, NULL::uuid AS grupo_id,
              CASE WHEN p.tipo = 'alargue_retiro' THEN 'alargue' ELSE 'entrega' END AS origen
         FROM pagos p
        WHERE p.estado = 'validado' AND p.tipo IN ('flete', 'alargue_retiro')
          AND EXTRACT(YEAR FROM p.creado_en) = $1
        UNION ALL
       -- grupo_id no-nulo detecta un recambio de cuenta corriente directo
       -- (registrarRecambioCC en recambio.flow.ts): esa pata 'entrega' no
       -- tiene pedidos detrás (nunca pasa por cotización), así que la
       -- columna CATEGORÍA no puede depender de pedidos.tipo para este caso.
       SELECT v.fecha AS fecha, v.importe::numeric AS importe, NULL::uuid AS pedido_id, v.contenedor_numero,
              v.cliente_telefono, TRUE AS es_cuenta_corriente, v.grupo_id,
              'entrega' AS origen
         FROM viajes v
        WHERE v.es_cuenta_corriente = TRUE AND v.tipo = 'entrega' AND v.importe IS NOT NULL
          AND EXTRACT(YEAR FROM v.fecha) = $1
     )
     SELECT i.fecha::text AS fecha,
            pe.numero_pedido,
            COALESCE(cl.nombre, pe.cliente_nombre) AS cliente_nombre,
            i.cliente_telefono,
            COALESCE(i.contenedor_numero, pe.contenedor_recambio_numero) AS contenedor_numero,
            COALESCE(pe.zona, (SELECT v2.zona FROM viajes v2 WHERE v2.contenedor_numero = i.contenedor_numero
                                 AND v2.fecha = i.fecha ORDER BY v2.creado_en DESC LIMIT 1)) AS zona,
            CASE
              WHEN i.origen = 'alargue' THEN 'Alargue de retiro'
              WHEN pe.tipo = 'recambio' OR i.grupo_id IS NOT NULL THEN 'Recambio'
              ELSE 'Entrega'
            END AS categoria,
            CASE WHEN i.es_cuenta_corriente THEN 'Cuenta corriente' ELSE 'Transferencia' END AS medio_pago,
            i.importe
       FROM ingresos i
       LEFT JOIN pedidos pe ON pe.id = i.pedido_id
       LEFT JOIN clientes cl ON cl.telefono = i.cliente_telefono
      ORDER BY i.fecha`,
    [anio],
  );
}

export interface ResumenMes {
  mes: string; // 'YYYY-MM'
  entregas: number;
  recambios: number;
  alargues: number;
  total: number;
  cantidad: number;
}

/** Agrupa movimientosIngreso() por mes calendario, para la tarjeta/gráfico del panel. */
export async function resumenMensual(anio: number): Promise<{ anio: number; meses: ResumenMes[]; total: number }> {
  const movimientos = await movimientosIngreso(anio);
  const porMes = new Map<string, ResumenMes>();
  for (let m = 1; m <= 12; m++) {
    const mes = `${anio}-${String(m).padStart(2, '0')}`;
    porMes.set(mes, { mes, entregas: 0, recambios: 0, alargues: 0, total: 0, cantidad: 0 });
  }
  for (const mv of movimientos) {
    const mes = mv.fecha.slice(0, 7);
    const acc = porMes.get(mes);
    if (!acc) continue; // no debería pasar (ya se filtró por año en SQL)
    if (mv.categoria === 'Alargue de retiro') acc.alargues += mv.importe;
    else if (mv.categoria === 'Recambio') acc.recambios += mv.importe;
    else acc.entregas += mv.importe;
    acc.total += mv.importe;
    acc.cantidad += 1;
  }
  const meses = [...porMes.values()];
  return { anio, meses, total: meses.reduce((s, m) => s + m.total, 0) };
}

/**
 * Excel de ingresos: mismo lenguaje visual que excelClientes() en
 * reportes.service.ts (logo + MORATRANS en azul, barra de acento azul/rojo,
 * encabezado de tabla azul con texto blanco, filas bandeadas) para que se
 * sienta parte del mismo set de reportes de la empresa. Dos hojas: un
 * resumen mensual y el detalle movimiento por movimiento.
 */
export async function excelFinanzas(anio: number): Promise<Buffer> {
  const { meses, total } = await resumenMensual(anio);
  const movimientos = await movimientosIngreso(anio);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MoraTrans';
  wb.created = new Date();

  // ---------- Hoja 1: Resumen mensual ----------
  const columnasResumen = [
    { header: 'MES', key: 'mes', width: 14 },
    { header: 'ENTREGAS', key: 'entregas', width: 16 },
    { header: 'RECAMBIOS', key: 'recambios', width: 16 },
    { header: 'ALARGUES DE RETIRO', key: 'alargues', width: 20 },
    { header: 'TOTAL', key: 'total', width: 16 },
    { header: 'CANT. MOVIMIENTOS', key: 'cantidad', width: 18 },
  ];
  const wsResumen = wb.addWorksheet('Resumen mensual');
  dibujarEncabezadoHoja(wsResumen, columnasResumen.length, `Ingresos ${anio}`, `Generado: ${new Date().toLocaleString('es-AR')}`);
  wsResumen.columns = columnasResumen.map((c) => ({ key: c.key, width: c.width }));
  dibujarFilaHeaderTabla(wsResumen, 5, columnasResumen);
  wsResumen.views = [{ state: 'frozen', ySplit: 5 }];

  const NOMBRE_MES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  meses.forEach((m, i) => {
    const fila = wsResumen.addRow({
      mes: NOMBRE_MES[Number(m.mes.slice(5, 7)) - 1],
      entregas: m.entregas,
      recambios: m.recambios,
      alargues: m.alargues,
      total: m.total,
      cantidad: m.cantidad,
    });
    if (i % 2 === 1) fila.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(AZUL_CLARO) } }));
  });
  const filaTotal = wsResumen.addRow({ mes: 'TOTAL DEL AÑO', entregas: meses.reduce((s, m) => s + m.entregas, 0),
    recambios: meses.reduce((s, m) => s + m.recambios, 0), alargues: meses.reduce((s, m) => s + m.alargues, 0),
    total, cantidad: meses.reduce((s, m) => s + m.cantidad, 0) });
  filaTotal.font = { bold: true };
  filaTotal.eachCell((c) => (c.border = { top: { style: 'thin', color: { argb: argb(AZUL) } } }));
  ['entregas', 'recambios', 'alargues', 'total'].forEach((k) => (wsResumen.getColumn(k).numFmt = '"$"#,##0.00'));
  dibujarPieHoja(wsResumen, columnasResumen.length);

  // ---------- Hoja 2: Detalle ----------
  const columnasDetalle = [
    { header: 'FECHA', key: 'fecha', width: 12 },
    { header: 'Nº PEDIDO', key: 'numero_pedido', width: 12 },
    { header: 'CLIENTE', key: 'cliente_nombre', width: 26 },
    { header: 'TELÉFONO', key: 'cliente_telefono', width: 16 },
    { header: 'CONTENEDOR', key: 'contenedor_numero', width: 16 },
    { header: 'ZONA', key: 'zona', width: 18 },
    { header: 'TIPO', key: 'categoria', width: 16 },
    { header: 'MEDIO DE PAGO', key: 'medio_pago', width: 16 },
    { header: 'IMPORTE', key: 'importe', width: 14 },
  ];
  const wsDetalle = wb.addWorksheet('Detalle');
  dibujarEncabezadoHoja(wsDetalle, columnasDetalle.length, `Detalle de ingresos ${anio}`, `${movimientos.length} movimientos · Generado: ${new Date().toLocaleString('es-AR')}`);
  wsDetalle.columns = columnasDetalle.map((c) => ({ key: c.key, width: c.width }));
  dibujarFilaHeaderTabla(wsDetalle, 5, columnasDetalle);
  wsDetalle.views = [{ state: 'frozen', ySplit: 5 }];

  movimientos.forEach((mv, i) => {
    const fila = wsDetalle.addRow({ ...mv, fecha: formatearFechaCortaLocal(mv.fecha) });
    if (i % 2 === 1) fila.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(AZUL_CLARO) } }));
  });
  wsDetalle.getColumn('importe').numFmt = '"$"#,##0.00';
  dibujarPieHoja(wsDetalle, columnasDetalle.length);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function formatearFechaCortaLocal(fechaISO: string): string {
  const [y, m, d] = fechaISO.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Bloque de marca compartido por ambas hojas: logo + MORATRANS a la izquierda, título a la derecha, barra de acento. */
function dibujarEncabezadoHoja(ws: ExcelJS.Worksheet, ultimaCol: number, titulo: string, subtitulo: string): void {
  ws.getRow(1).height = 46;
  try {
    const wb = ws.workbook;
    const imageId = wb.addImage({ filename: LOGO_PATH, extension: 'jpeg' });
    ws.addImage(imageId, { tl: { col: 0.15, row: 0.1 }, ext: { width: 40, height: 40 } });
  } catch {
    // Sin logo disponible, el resto de la planilla sigue igual.
  }
  ws.mergeCells(1, 2, 1, Math.max(3, Math.ceil(ultimaCol / 2)));
  const celdaTitulo = ws.getCell(1, 2);
  celdaTitulo.value = 'MORATRANS';
  celdaTitulo.font = { bold: true, size: 16, color: { argb: argb(AZUL) } };
  celdaTitulo.alignment = { vertical: 'middle' };

  ws.mergeCells(1, Math.max(4, Math.ceil(ultimaCol / 2) + 1), 1, ultimaCol);
  const celdaSubtitulo = ws.getCell(1, Math.max(4, Math.ceil(ultimaCol / 2) + 1));
  celdaSubtitulo.value = titulo.toUpperCase();
  celdaSubtitulo.font = { bold: true, size: 12, color: { argb: argb(ROJO) } };
  celdaSubtitulo.alignment = { vertical: 'middle', horizontal: 'right' };

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

function dibujarFilaHeaderTabla(ws: ExcelJS.Worksheet, filaNum: number, columnas: { header: string }[]): void {
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

function dibujarPieHoja(ws: ExcelJS.Worksheet, ultimaCol: number): void {
  const filaPie = ws.lastRow ? ws.lastRow.number + 2 : 7;
  ws.mergeCells(filaPie, 1, filaPie, ultimaCol);
  const celda = ws.getCell(filaPie, 1);
  celda.value = 'MoraTrans — Reporte generado automáticamente por el panel de gestión.';
  celda.font = { size: 9, color: { argb: argb(GRIS_MUTED) } };
  celda.alignment = { horizontal: 'center' };
}
