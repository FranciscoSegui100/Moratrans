import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../api/client';

/**
 * Descarga el comprobante autenticado (Bearer) y lo muestra como imagen o
 * link a PDF. Si se pasa `adjuntoId`, descarga un comprobante adicional del
 * mismo pago (ver pagos_adjuntos) en vez del principal. Con `mensajeId` (en
 * vez de `pagoId`) descarga el archivo que el cliente mandó en ese mensaje
 * del chat, que puede no estar todavía registrado como pago.
 */
export function ComprobanteViewer({
  pagoId,
  adjuntoId,
  mensajeId,
  viajeFotoId,
}: {
  pagoId?: string;
  adjuntoId?: string;
  mensajeId?: string;
  viajeFotoId?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [esPdf, setEsPdf] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelado = false;
    const endpoint = viajeFotoId
      ? `/api/clientes/viajes/${viajeFotoId}/foto-entrega`
      : mensajeId
        ? `/api/chat/mensaje/${mensajeId}/adjunto`
        : adjuntoId
          ? `/api/pagos/${pagoId}/adjuntos/${adjuntoId}`
          : `/api/pagos/${pagoId}/comprobante`;

    api
      .get(endpoint, { responseType: 'blob' })
      .then((r) => {
        if (cancelado) return;
        objectUrl = URL.createObjectURL(r.data);
        setUrl(objectUrl);
        setEsPdf(String(r.data.type).includes('pdf'));
      })
      .catch(() => !cancelado && setError(true));

    return () => {
      cancelado = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pagoId, adjuntoId, mensajeId, viajeFotoId]);

  if (error) return <div className="comprobante-error">No se pudo cargar el comprobante</div>;
  if (!url) return <div className="comprobante-loading">Cargando comprobante…</div>;

  if (esPdf) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="comprobante-link">
        <FileText strokeWidth={1.75} /> Ver comprobante (PDF)
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Comprobante de pago" className="comprobante-thumb" />
    </a>
  );
}
