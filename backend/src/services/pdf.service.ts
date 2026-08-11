import PDFDocument from 'pdfkit';
import { subirArchivo } from './storage.service';
import { uploadMedia, sendDocument } from '../modules/whatsapp/graphApi';

export interface DatosTicket {
  ticketId: string;
  contenedor: string;
  zona: string;
  precio?: number | string;
  moneda?: string;
  clienteTelefono: string;
  fecha: Date;
}

/** Genera el PDF del ticket en memoria y devuelve el buffer. */
function generarTicketPDF(d: DatosTicket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('Ticket de Reserva Logística', { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).fillColor('#555').text(`Emitido: ${d.fecha.toLocaleString('es-UY')}`, { align: 'center' });
    doc.moveDown(2);

    const filas: [string, string][] = [
      ['N° de Ticket', d.ticketId],
      ['Contenedor asignado', d.contenedor],
      ['Zona / Departamento', d.zona],
      ['Precio', d.precio != null ? `${d.moneda ?? ''} ${Number(d.precio).toLocaleString('es-AR')}`.trim() : '—'],
      ['Cliente', d.clienteTelefono],
    ];
    doc.fillColor('#000').fontSize(12);
    for (const [k, v] of filas) {
      doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(v);
      doc.moveDown(0.5);
    }

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#888').text(
      'Este ticket confirma la reserva del contenedor. Conservalo para el retiro/entrega.',
      { align: 'center' },
    );

    doc.end();
  });
}

/** Genera el ticket, lo guarda en Supabase Storage y lo envía al cliente por WhatsApp. */
export async function enviarTicketPorWhatsApp(d: DatosTicket): Promise<void> {
  const buffer = await generarTicketPDF(d);
  const filename = `ticket_${d.ticketId}.pdf`;
  await subirArchivo(buffer, `tickets/${filename}`, 'application/pdf');
  const mediaId = await uploadMedia(buffer, 'application/pdf', filename);
  await sendDocument(
    d.clienteTelefono,
    mediaId,
    filename,
    `✅ ¡Pago validado! Tu contenedor asignado es ${d.contenedor}.`,
  );
}
