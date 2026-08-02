import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { uploadMedia, sendDocument } from '../modules/whatsapp/graphApi';

export interface DatosTicket {
  ticketId: string;
  contenedor: string;
  zona: string;
  precio?: number | string;
  clienteTelefono: string;
  fecha: Date;
}

/** Genera un PDF de ticket y devuelve la ruta local. */
export function generarTicketPDF(d: DatosTicket): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = path.resolve(env.MEDIA_DIR, 'tickets');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `ticket_${d.ticketId}.pdf`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(20).text('Ticket de Reserva Logística', { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).fillColor('#555').text(`Emitido: ${d.fecha.toLocaleString('es-UY')}`, { align: 'center' });
    doc.moveDown(2);

    const filas: [string, string][] = [
      ['N° de Ticket', d.ticketId],
      ['Contenedor asignado', d.contenedor],
      ['Zona / Departamento', d.zona],
      ['Precio', d.precio != null ? `UYU ${Number(d.precio).toLocaleString('es-UY')}` : '—'],
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
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

/** Genera el ticket, lo sube a /media y lo envía al cliente por WhatsApp. */
export async function enviarTicketPorWhatsApp(d: DatosTicket): Promise<string> {
  const filePath = await generarTicketPDF(d);
  const mediaId = await uploadMedia(filePath, 'application/pdf');
  await sendDocument(
    d.clienteTelefono,
    mediaId,
    `ticket_${d.ticketId}.pdf`,
    `✅ ¡Pago validado! Tu contenedor asignado es ${d.contenedor}.`,
  );
  return filePath;
}
