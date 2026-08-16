import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { query } from '../../config/db';

/** Genera un Excel (buffer) con el estado actual de los contenedores. */
export async function excelContenedores(): Promise<Buffer> {
  const rows = await query<{ numero: string; estado: string; vence_en: string | null; actualizado_en: string }>(
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

/**
 * Genera un Excel (buffer) con los viajes de todos los clientes, seccionado
 * en una hoja por mes (a menos que se pida un mes puntual, que queda en una
 * sola hoja). El "cliente" de un viaje se referencia por teléfono (igual que
 * en el resto del sistema, ver clientes.service.ts); si todavía no está en
 * el padrón `clientes` se muestra el teléfono en su lugar.
 */
export async function excelClientes(mes?: string): Promise<Buffer> {
  const rows = await query<{
    cliente_nombre: string;
    cliente_telefono: string;
    tipo: string;
    fecha: string;
    estado: string;
    zona: string | null;
    contenedor_numero: string | null;
    mes: string;
  }>(
    `SELECT COALESCE(cl.nombre, v.cliente_telefono) AS cliente_nombre, v.cliente_telefono,
            v.tipo, v.fecha, v.estado, v.zona, v.contenedor_numero,
            to_char(v.fecha, 'YYYY-MM') AS mes
       FROM viajes v
       LEFT JOIN clientes cl ON cl.telefono = v.cliente_telefono
      WHERE v.cliente_telefono IS NOT NULL
        AND ($1::text IS NULL OR to_char(v.fecha, 'YYYY-MM') = $1)
      ORDER BY v.fecha`,
    [mes ?? null],
  );

  const wb = new ExcelJS.Workbook();
  const meses = [...new Set(rows.map((r) => r.mes))].sort();
  const columnas = [
    { header: 'Cliente', key: 'cliente_nombre', width: 26 },
    { header: 'Teléfono', key: 'cliente_telefono', width: 18 },
    { header: 'Tipo', key: 'tipo', width: 12 },
    { header: 'Fecha', key: 'fecha', width: 14 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Zona', key: 'zona', width: 18 },
    { header: 'Contenedor', key: 'contenedor_numero', width: 18 },
  ];
  for (const m of meses.length ? meses : [mes ?? 'sin_datos']) {
    const ws = wb.addWorksheet(m);
    ws.columns = columnas;
    ws.getRow(1).font = { bold: true };
    rows.filter((r) => r.mes === m).forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
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
