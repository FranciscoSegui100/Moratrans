import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { query } from '../../config/db';
import { uploadMedia, sendDocument } from '../whatsapp/graphApi';
import { formatearFechaCorta } from '../../services/diasHabiles.service';

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
 * Genera un Excel (buffer) con los viajes de todos los clientes, en el mismo
 * formato de la planilla que ya usaban antes del sistema (columnas FECHA,
 * CHA/EQU, PAT, POSICIÓN, TIPO BULTO, CANTIDAD, Nº REMITO, IMPORTE, CHOFER,
 * Nº PLAN.) — seccionado en una hoja por mes, a menos que se pida un mes
 * puntual. "CHA/EQU" y "CANTIDAD" son fijos porque hoy el sistema solo
 * mueve contenedores de a uno por viaje. "TIPO BULTO" se deriva:
 * 'entrega' -> VACIO (deja un contenedor vacío), 'retiro' con grupo_id (es
 * parte de un recambio, ver recambio.flow.ts) -> Recambio, 'retiro' suelto
 * -> Retiro.
 */
export async function excelClientes(mes?: string, telefono?: string): Promise<Buffer> {
  const rows = await query<{
    fecha: string;
    patente: string | null;
    posicion: string | null;
    tipo_bulto: string;
    remito: string | null;
    importe: string | null;
    chofer_nombre: string | null;
    numero_plan: number | null;
    mes: string;
  }>(
    `SELECT v.fecha, v.patente, COALESCE(v.destino_direccion, v.zona) AS posicion,
            CASE
              WHEN v.tipo = 'entrega' THEN 'VACIO'
              WHEN v.tipo = 'retiro' AND v.grupo_id IS NOT NULL THEN 'Recambio'
              ELSE 'Retiro'
            END AS tipo_bulto,
            v.remito, v.importe, ch.nombre AS chofer_nombre, cl.numero_plan,
            to_char(v.fecha, 'YYYY-MM') AS mes
       FROM viajes v
       LEFT JOIN choferes ch ON ch.id = v.chofer_id
       LEFT JOIN clientes cl ON cl.telefono = v.cliente_telefono
      WHERE v.cliente_telefono IS NOT NULL
        AND ($1::text IS NULL OR to_char(v.fecha, 'YYYY-MM') = $1)
        AND ($2::text IS NULL OR v.cliente_telefono = $2)
      ORDER BY v.fecha`,
    [mes ?? null, telefono ?? null],
  );

  const wb = new ExcelJS.Workbook();
  const meses = [...new Set(rows.map((r) => r.mes))].sort();
  const columnas = [
    { header: 'FECHA', key: 'fecha', width: 12 },
    { header: 'CHA/EQU', key: 'cha_equ', width: 12 },
    { header: 'PAT', key: 'patente', width: 12 },
    { header: 'POSICIÓN', key: 'posicion', width: 28 },
    { header: 'TIPO BULTO', key: 'tipo_bulto', width: 12 },
    { header: 'CANTIDAD', key: 'cantidad', width: 10 },
    { header: 'Nº REMITO', key: 'remito', width: 12 },
    { header: 'IMPORTE', key: 'importe', width: 14 },
    { header: 'CHOFER', key: 'chofer_nombre', width: 16 },
    { header: 'Nº PLAN.', key: 'numero_plan', width: 10 },
  ];
  for (const m of meses.length ? meses : [mes ?? 'sin_datos']) {
    const ws = wb.addWorksheet(m);
    ws.columns = columnas;
    ws.getRow(1).font = { bold: true };
    rows
      .filter((r) => r.mes === m)
      .forEach((r) => ws.addRow({ ...r, cha_equ: 'Contenedor', cantidad: 1 }));
    ws.getColumn('importe').numFmt = '"$"#,##0.00';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
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

/** Nombre de archivo seguro: solo letras/números/espacios/guiones, sin extensión. */
function nombreArchivoSeguro(base: string): string {
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos, deja las letras base
    .replace(/[^a-zA-Z0-9 -]/g, '')
    .trim();
}

/**
 * PDF de "Resumen de cuenta" para un cliente de cuenta corriente: cada
 * pedido/entrega con zona y precio, y el total al pie — es lo que el
 * cliente pide desde el menú de WhatsApp (ver movimientos.flow.ts). Para
 * pagar, se lo redirige a "Enviar comprobante" (ese flujo sí concilia el
 * pago con un operador; este PDF es solo informativo).
 */
export function pdfResumenCuentaCorriente(clienteNombre: string, items: ItemCuentaCorriente[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('MORATRANS — Cuenta corriente', { align: 'center' });
    doc.fontSize(13).fillColor('#333').text(clienteNombre, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#777').text(`Generado: ${new Date().toLocaleString('es-AR')}`, { align: 'center' });
    doc.moveDown();

    doc.fillColor('#000').fontSize(11);
    let total = 0;
    if (items.length === 0) {
      doc.text('No hay pedidos pendientes.');
    } else {
      items.forEach((it) => {
        const monto = it.monto ? Number(it.monto) : 0;
        total += monto;
        doc.text(
          `${formatearFechaCorta(it.fecha)}  ·  ${it.zona ?? 'Sin zona'}  ·  ` +
            `${it.monto ? '$' + monto.toLocaleString('es-AR') : 's/monto'}`,
        );
      });
      doc.moveDown();
      doc.fontSize(13).text(`Total: $${total.toLocaleString('es-AR')}`, { align: 'right' });
    }
    doc.end();
  });
}

/**
 * Genera y manda por WhatsApp el resumen de cuenta corriente de un cliente
 * (ver pdfResumenCuentaCorriente) — lo dispara el propio cliente desde el
 * menú "📊 Resumen de cuenta" (movimientos.flow.ts).
 */
export async function enviarResumenCuentaCorrientePorWhatsApp(telefono: string, clienteNombre: string | null): Promise<void> {
  const items = await itemsCuentaCorriente(telefono);
  const nombre = clienteNombre ?? 'Cliente';
  const buf = await pdfResumenCuentaCorriente(nombre, items);
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
