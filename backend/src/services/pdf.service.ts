import path from 'path';
import PDFDocument from 'pdfkit';
import { subirArchivo } from './storage.service';
import { uploadMedia, sendDocument } from '../modules/whatsapp/graphApi';

// Colores de marca (del logo: círculo azul marino con ruta roja).
const AZUL = '#152B54';
const AZUL_CLARO = '#EEF1F8';
const ROJO = '#E12A26';
const GRIS_TEXTO = '#374151';
const GRIS_MUTED = '#6B7280';

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.jpg');
const MARGEN = 50;

export interface DatosTicket {
  ticketId: string;
  numeroPedido?: number | string | null;
  contenedor?: string | null;
  zona: string;
  destinoDireccion?: string | null;
  fechaEntrega?: string | null;
  fechaRetiroEstimada?: string | null;
  horarioPreferido?: string | null;
  precio?: number | string | null;
  moneda?: string | null;
  clienteNombre?: string | null;
  clienteTelefono: string;
  medioPago: 'transferencia' | 'cuenta_corriente';
  titularTransferencia?: string | null;
  fecha: Date;
}

function formatearMonto(precio: number | string | null | undefined, moneda: string | null | undefined): string {
  if (precio == null) return '—';
  return `${moneda ?? ''} ${Number(precio).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`.trim();
}

/**
 * La fuente estándar (Helvetica/WinAnsi) que usa pdfkit no tiene glifos para
 * emoji — sin esto, textos como "🌅 Mañana (8-12hs)" (ver
 * horarioPreferido.flow.ts) salían con caracteres corruptos en el PDF.
 */
function limpiarTexto(s: string): string {
  return s.replace(/[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '').trim();
}

/** Encabezado: logo + nombre de la empresa a la izquierda, título del comprobante a la derecha. */
function dibujarEncabezado(doc: PDFKit.PDFDocument, d: DatosTicket): number {
  const anchoUtil = doc.page.width - MARGEN * 2;
  let y = MARGEN;

  try {
    doc.image(LOGO_PATH, MARGEN, y, { width: 54, height: 54 });
  } catch {
    // Si el logo no está disponible (ej. entorno sin dist/assets), el resto del PDF sigue andando.
  }

  doc
    .fillColor(AZUL)
    .font('Helvetica-Bold')
    .fontSize(20)
    .text('MORATRANS', MARGEN + 66, y + 6);
  doc
    .fillColor(GRIS_MUTED)
    .font('Helvetica')
    .fontSize(9)
    .text('Logística de contenedores', MARGEN + 66, y + 30);

  doc
    .fillColor(ROJO)
    .font('Helvetica-Bold')
    .fontSize(14)
    .text('COMPROBANTE DE PAGO', MARGEN, y + 4, { width: anchoUtil, align: 'right' });
  doc
    .fillColor(GRIS_MUTED)
    .font('Helvetica')
    .fontSize(9)
    .text(`N° ${d.ticketId}`, MARGEN, y + 24, { width: anchoUtil, align: 'right' })
    .text(d.fecha.toLocaleString('es-AR'), MARGEN, y + 37, { width: anchoUtil, align: 'right' });

  y += 70;
  doc.rect(0, y, doc.page.width, 5).fill(AZUL);
  doc.rect(doc.page.width * 0.7, y, doc.page.width * 0.3, 5).fill(ROJO);
  return y + 5;
}

/** Título de sección: barra clara con texto en azul. */
function dibujarTituloSeccion(doc: PDFKit.PDFDocument, y: number, titulo: string): number {
  const anchoUtil = doc.page.width - MARGEN * 2;
  doc.rect(MARGEN, y, anchoUtil, 22).fill(AZUL_CLARO);
  doc
    .fillColor(AZUL)
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(titulo.toUpperCase(), MARGEN + 10, y + 6);
  return y + 22 + 10;
}

/** Una fila etiqueta/valor dentro de una sección. */
function dibujarFila(doc: PDFKit.PDFDocument, y: number, etiqueta: string, valorCrudo: string): number {
  const anchoUtil = doc.page.width - MARGEN * 2;
  const valor = limpiarTexto(valorCrudo);
  doc
    .fillColor(GRIS_MUTED)
    .font('Helvetica')
    .fontSize(10)
    .text(etiqueta, MARGEN, y, { width: 150 });
  const alturaValor = doc
    .fillColor(GRIS_TEXTO)
    .font('Helvetica-Bold')
    .fontSize(10)
    .heightOfString(valor, { width: anchoUtil - 150 });
  doc.text(valor, MARGEN + 150, y, { width: anchoUtil - 150 });
  return y + Math.max(16, alturaValor + 4);
}

/** Recuadro destacado con el monto total pagado. */
function dibujarMontoDestacado(doc: PDFKit.PDFDocument, y: number, texto: string): number {
  const anchoUtil = doc.page.width - MARGEN * 2;
  const alto = 46;
  doc.rect(MARGEN, y, anchoUtil, alto).fill(AZUL);
  doc
    .fillColor('#FFFFFF')
    .font('Helvetica')
    .fontSize(10)
    .text('TOTAL PAGADO', MARGEN + 16, y + 10);
  doc
    .fillColor('#FFFFFF')
    .font('Helvetica-Bold')
    .fontSize(18)
    .text(texto, MARGEN, y + 8, { width: anchoUtil - 16, align: 'right' });
  return y + alto + 20;
}

function dibujarPiePagina(doc: PDFKit.PDFDocument): void {
  const y = doc.page.height - 70;
  doc.rect(0, y, doc.page.width * 0.7, 4).fill(AZUL);
  doc.rect(doc.page.width * 0.7, y, doc.page.width * 0.3, 4).fill(ROJO);
  doc
    .fillColor(GRIS_MUTED)
    .font('Helvetica')
    .fontSize(9)
    .text('¡Gracias por confiar en MoraTrans!', 0, y + 16, { width: doc.page.width, align: 'center' })
    .fontSize(8)
    .text('Este comprobante certifica la validación del pago y la reserva de tu pedido.', 0, y + 30, {
      width: doc.page.width,
      align: 'center',
    });
}

/** Genera el PDF del comprobante en memoria y devuelve el buffer. */
function generarTicketPDF(d: DatosTicket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = dibujarEncabezado(doc, d);
    y += 25;

    y = dibujarTituloSeccion(doc, y, 'Datos del cliente');
    y = dibujarFila(doc, y, 'Nombre', d.clienteNombre ?? 'Sin nombre registrado');
    y = dibujarFila(doc, y, 'Teléfono', d.clienteTelefono);
    y += 15;

    y = dibujarTituloSeccion(doc, y, 'Detalle del pedido');
    if (d.numeroPedido != null) y = dibujarFila(doc, y, 'N° de pedido', String(d.numeroPedido));
    y = dibujarFila(doc, y, 'Contenedor', d.contenedor ? d.contenedor : 'A asignar al planificar la ruta');
    y = dibujarFila(doc, y, 'Zona / Departamento', d.zona);
    if (d.destinoDireccion) y = dibujarFila(doc, y, 'Dirección de entrega', d.destinoDireccion);
    if (d.fechaEntrega) y = dibujarFila(doc, y, 'Fecha de entrega', d.fechaEntrega);
    if (d.horarioPreferido) y = dibujarFila(doc, y, 'Franja horaria', d.horarioPreferido);
    if (d.fechaRetiroEstimada) y = dibujarFila(doc, y, 'Retiro estimado', d.fechaRetiroEstimada);
    y += 15;

    y = dibujarTituloSeccion(doc, y, 'Datos del pago');
    y = dibujarFila(doc, y, 'Medio de pago', d.medioPago === 'cuenta_corriente' ? 'Cuenta corriente' : 'Transferencia bancaria');
    if (d.titularTransferencia) y = dibujarFila(doc, y, 'Titular de la transferencia', d.titularTransferencia);
    y += 10;

    dibujarMontoDestacado(doc, y, formatearMonto(d.precio, d.moneda));
    dibujarPiePagina(doc);

    doc.end();
  });
}

/** Genera el comprobante, lo guarda en Supabase Storage y lo envía al cliente por WhatsApp. */
export async function enviarTicketPorWhatsApp(d: DatosTicket): Promise<void> {
  const buffer = await generarTicketPDF(d);
  const filename = `comprobante_${d.ticketId}.pdf`;
  await subirArchivo(buffer, `tickets/${filename}`, 'application/pdf');
  const mediaId = await uploadMedia(buffer, 'application/pdf', filename);
  const caption = d.contenedor
    ? `✅ ¡Pago validado! Tu contenedor asignado es ${d.contenedor}.`
    : `✅ ¡Pago validado! Tu pedido fue confirmado y registrado exitosamente.`;

  await sendDocument(
    d.clienteTelefono,
    mediaId,
    filename,
    caption,
  );
}
