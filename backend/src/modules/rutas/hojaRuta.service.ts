import PDFDocument from 'pdfkit';
import { query } from '../../config/db';
import { hoyMendozaISO } from '../../services/fechas.service';
import { formatearFechaCorta } from '../../services/diasHabiles.service';
import {
  AZUL,
  AZUL_CLARO,
  ROJO,
  GRIS_TEXTO,
  GRIS_MUTED,
  MARGEN,
  limpiarTexto,
  dibujarEncabezado,
  dibujarTituloSeccion,
} from '../../services/pdf.service';

interface FilaBolsa {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  zona: string | null;
  contenedor_numero: string | null;
  destino_direccion: string | null;
  horario_preferido: string | null;
  cliente_telefono: string | null;
  cliente_nombre: string | null;
  grupo_id: string | null;
  notas: string | null;
  remito: string | null;
}

/** Una parada de la hoja: un recambio (retiro+entrega con el mismo grupo_id) cuenta como una sola, igual que en la bolsa del panel. */
interface ParadaHoja {
  tipo: 'Entrega' | 'Retiro' | 'Recambio';
  fecha: string;
  zona: string;
  direccion: string | null;
  horario: string | null;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  contenedorEntrega: string | null;
  contenedorRetiro: string | null;
  notas: string[];
  remito: string | null;
}

/**
 * Pedidos sin rutear que la bolsa del panel muestra para `fecha` — mismo
 * criterio de "fecha efectiva" que Rutas.tsx: lo atrasado vive en la bolsa de
 * HOY (y en ningún día pasado), así la hoja impresa coincide con lo que el
 * operador ve en pantalla.
 */
async function paradasDeLaBolsa(fecha: string): Promise<ParadaHoja[]> {
  const hoy = hoyMendozaISO();
  if (fecha < hoy) return [];
  const condFecha = fecha === hoy ? `v.fecha <= $1` : `v.fecha = $1`;
  const filas = await query<FilaBolsa>(
    `SELECT v.id, v.tipo, v.fecha::text AS fecha, v.zona, v.contenedor_numero, v.destino_direccion,
            v.horario_preferido, v.cliente_telefono, v.grupo_id, v.notas, v.remito,
            NULLIF(cl.nombre, 'Sin nombre') AS cliente_nombre
       FROM viajes v
       LEFT JOIN clientes cl ON cl.telefono = v.cliente_telefono
      WHERE v.ruta_id IS NULL AND v.estado IN ('programado', 'en_curso') AND ${condFecha}
      ORDER BY v.fecha, v.creado_en`,
    [fecha],
  );

  const porGrupo = new Map<string, FilaBolsa[]>();
  const visitas: FilaBolsa[][] = [];
  for (const f of filas) {
    if (!f.grupo_id) { visitas.push([f]); continue; }
    const grupo = porGrupo.get(f.grupo_id);
    if (grupo) { grupo.push(f); continue; }
    const nuevo = [f];
    porGrupo.set(f.grupo_id, nuevo);
    visitas.push(nuevo);
  }

  const paradas = visitas.map((grupo): ParadaHoja => {
    const entrega = grupo.find((f) => f.tipo === 'entrega');
    const retiro = grupo.find((f) => f.tipo === 'retiro');
    const primero = (campo: 'zona' | 'destino_direccion' | 'horario_preferido' | 'cliente_nombre' | 'cliente_telefono' | 'remito') =>
      grupo.map((f) => f[campo]).find((x) => x) ?? null;
    const direccion = primero('destino_direccion');
    return {
      tipo: entrega && retiro ? 'Recambio' : entrega ? 'Entrega' : 'Retiro',
      fecha: grupo[0].fecha,
      zona: primero('zona') ?? (direccion ? direccion.split(',')[0] : 'Sin zona'),
      direccion,
      horario: primero('horario_preferido'),
      clienteNombre: primero('cliente_nombre'),
      clienteTelefono: primero('cliente_telefono'),
      contenedorEntrega: entrega?.contenedor_numero ?? null,
      contenedorRetiro: retiro?.contenedor_numero ?? null,
      notas: [...new Set(grupo.map((f) => f.notas?.trim()).filter((n): n is string => !!n))],
      remito: primero('remito'),
    };
  });

  return paradas.sort((a, b) =>
    a.zona.localeCompare(b.zona, 'es') || a.fecha.localeCompare(b.fecha) || (a.horario ?? '').localeCompare(b.horario ?? ''));
}

const ALTO_PIE = 70;
const ANCHO_ORDEN = 62;

/** Mismas barras azul/roja que dibujarPiePagina, pero con texto interno (esta hoja no la ve el cliente). */
function dibujarPieHoja(doc: PDFKit.PDFDocument, pagina: number): void {
  const y = doc.page.height - ALTO_PIE;
  doc.rect(0, y, doc.page.width * 0.7, 4).fill(AZUL);
  doc.rect(doc.page.width * 0.7, y, doc.page.width * 0.3, 4).fill(ROJO);
  doc
    .fillColor(GRIS_MUTED)
    .font('Helvetica')
    .fontSize(8)
    .text(`Hoja de armado de ruta · uso interno · página ${pagina}`, 0, y + 16, {
      width: doc.page.width,
      align: 'center',
      lineBreak: false,
    });
}

/** Línea "Etiqueta: valor" dentro de la tarjeta de una parada; devuelve la altura que ocupó. */
function lineaDetalle(doc: PDFKit.PDFDocument, x: number, y: number, ancho: number, etiqueta: string, valor: string, medir = false): number {
  const texto = limpiarTexto(valor);
  doc.font('Helvetica').fontSize(9);
  const anchoEtiqueta = doc.widthOfString(`${etiqueta}: `);
  doc.font('Helvetica-Bold').fontSize(9);
  const alto = doc.heightOfString(texto, { width: ancho - anchoEtiqueta });
  if (!medir) {
    doc.fillColor(GRIS_MUTED).font('Helvetica').fontSize(9).text(`${etiqueta}: `, x, y, { width: anchoEtiqueta, lineBreak: false });
    doc.fillColor(GRIS_TEXTO).font('Helvetica-Bold').fontSize(9).text(texto, x + anchoEtiqueta, y, { width: ancho - anchoEtiqueta });
  }
  return Math.max(12, alto + 2);
}

/**
 * Dibuja (o solo mide, con `medir`) la tarjeta de una parada: a la izquierda
 * un recuadro vacío para anotar a mano el N° de orden, a la derecha los datos
 * del pedido y abajo la línea para escribir el chofer.
 */
function tarjetaParada(doc: PDFKit.PDFDocument, y: number, p: ParadaHoja, fechaHoja: string, medir = false): number {
  const anchoUtil = doc.page.width - MARGEN * 2;
  const xDatos = MARGEN + ANCHO_ORDEN + 12;
  const anchoDatos = anchoUtil - ANCHO_ORDEN - 22;
  const pad = 8;

  const detalles: [string, string][] = [];
  detalles.push(['Cliente', [p.clienteNombre, p.clienteTelefono].filter(Boolean).join(' · ') || '—']);
  detalles.push(['Dirección', p.direccion ?? 'Sin dirección']);
  if (p.horario) detalles.push(['Horario', p.horario]);
  if (p.tipo === 'Recambio') {
    detalles.push(['Contenedores', `retira ${p.contenedorRetiro ?? 'a definir'} · entrega ${p.contenedorEntrega ?? 'a asignar'}`]);
  } else if (p.tipo === 'Retiro') {
    detalles.push(['Contenedor', p.contenedorRetiro ?? 'a definir']);
  } else {
    detalles.push(['Contenedor', p.contenedorEntrega ?? 'a asignar']);
  }
  if (p.remito) detalles.push(['Remito', p.remito]);
  if (p.notas.length) detalles.push(['Notas', p.notas.join(' / ')]);

  let yy = y + pad;
  // Título: tipo + aviso de atrasado.
  if (!medir) {
    doc.fillColor(p.tipo === 'Retiro' ? ROJO : AZUL).font('Helvetica-Bold').fontSize(11).text(p.tipo.toUpperCase(), xDatos, yy, { lineBreak: false });
    if (p.fecha < fechaHoja) {
      doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(8)
        .text(`ATRASADO · era para el ${formatearFechaCorta(p.fecha)}`, xDatos, yy + 2, { width: anchoDatos, align: 'right', lineBreak: false });
    }
  }
  yy += 16;
  for (const [etiqueta, valor] of detalles) {
    yy += lineaDetalle(doc, xDatos, yy, anchoDatos, etiqueta, valor, medir);
  }
  yy += 8;
  // Renglón para escribir el chofer a mano.
  if (!medir) {
    doc.fillColor(GRIS_MUTED).font('Helvetica').fontSize(9).text('Chofer:', xDatos, yy + 4, { lineBreak: false });
    const xLinea = xDatos + doc.widthOfString('Chofer: ') + 4;
    doc.moveTo(xLinea, yy + 14).lineTo(xDatos + anchoDatos, yy + 14).lineWidth(0.7).strokeColor(GRIS_MUTED).stroke();
  }
  yy += 18 + pad;

  const alto = Math.max(yy - y, 80);
  if (!medir) {
    doc.rect(MARGEN, y, anchoUtil, alto).lineWidth(0.8).strokeColor(AZUL_CLARO).stroke();
    // Recuadro del N° de orden.
    doc.rect(MARGEN, y, ANCHO_ORDEN, alto).fill(AZUL_CLARO);
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(8)
      .text('ORDEN', MARGEN, y + 8, { width: ANCHO_ORDEN, align: 'center', lineBreak: false });
    const lado = 40;
    doc.rect(MARGEN + (ANCHO_ORDEN - lado) / 2, y + 22, lado, lado).lineWidth(1).fillAndStroke('#FFFFFF', AZUL);
  }
  return y + alto;
}

/**
 * GET /api/rutas/bolsa.pdf: hoja imprimible con los pedidos pendientes del
 * día, agrupados por zona, para que quien arma la ruta la ordene en papel
 * (orden de paradas y chofer a mano) antes de cargarla en el panel.
 */
export async function pdfHojaRuta(fecha: string): Promise<Buffer> {
  const paradas = await paradasDeLaBolsa(fecha);
  const choferes = await query<{ nombre: string }>(`SELECT nombre FROM choferes WHERE activo ORDER BY nombre`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const anchoUtil = doc.page.width - MARGEN * 2;
    const limite = () => doc.page.height - ALTO_PIE - 15;
    const cuenta = (t: ParadaHoja['tipo']) => paradas.filter((p) => p.tipo === t).length;
    const lineasEncabezado = [`Reparto del ${formatearFechaCorta(fecha)}`, `Generada ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' })}`];
    let pagina = 1;

    let y = dibujarEncabezado(doc, 'HOJA DE RUTA', lineasEncabezado);
    y += 20;

    // Resumen + choferes activos, para tener a mano a quién repartir.
    doc.fillColor(GRIS_TEXTO).font('Helvetica-Bold').fontSize(10)
      .text(`${paradas.length} paradas pendientes  ·  ${cuenta('Entrega')} entregas  ·  ${cuenta('Retiro')} retiros  ·  ${cuenta('Recambio')} recambios`, MARGEN, y, { width: anchoUtil });
    y += 16;
    if (choferes.length) {
      const textoChoferes = `Choferes activos: ${choferes.map((c) => c.nombre).join(', ')}`;
      doc.fillColor(GRIS_MUTED).font('Helvetica').fontSize(9).text(textoChoferes, MARGEN, y, { width: anchoUtil });
      y += doc.heightOfString(textoChoferes, { width: anchoUtil }) + 4;
    }
    y += 12;

    const nuevaPagina = () => {
      dibujarPieHoja(doc, pagina);
      doc.addPage({ size: 'A4', margin: 0 });
      pagina++;
      y = dibujarEncabezado(doc, 'HOJA DE RUTA', lineasEncabezado) + 20;
    };

    if (paradas.length === 0) {
      y = dibujarTituloSeccion(doc, y, 'Sin pedidos');
      doc.fillColor(GRIS_TEXTO).font('Helvetica').fontSize(10)
        .text('No hay viajes pendientes sin rutear para este día.', MARGEN, y, { width: anchoUtil });
    }

    let zonaActual: string | null = null;
    for (const p of paradas) {
      const altoTarjeta = tarjetaParada(doc, 0, p, fecha, true);
      let titulo: string | null = null;
      if (p.zona !== zonaActual) {
        titulo = `${limpiarTexto(p.zona)} (${paradas.filter((x) => x.zona === p.zona).length})`;
      }
      if (y + altoTarjeta + 32 > limite()) {
        nuevaPagina();
        // Si la zona sigue en la página nueva, se repite el título para no perder de qué zona es.
        titulo ??= `${limpiarTexto(p.zona)} (continuación)`;
      }
      if (titulo) {
        y = dibujarTituloSeccion(doc, y, titulo);
        zonaActual = p.zona;
      }
      y = tarjetaParada(doc, y, p, fecha) + 10;
    }

    dibujarPieHoja(doc, pagina);
    doc.end();
  });
}
