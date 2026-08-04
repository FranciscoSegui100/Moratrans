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
