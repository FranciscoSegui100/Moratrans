import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../api/client';

/**
 * Descarga el comprobante autenticado (Bearer) y lo muestra como imagen o
 * link a PDF. Si se pasa `adjuntoId`, descarga un comprobante adicional del
 * mismo pago (ver pagos_adjuntos) en vez del principal.
 */
export function ComprobanteViewer({ pagoId, adjuntoId }: { pagoId: string; adjuntoId?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [esPdf, setEsPdf] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelado = false;
    const endpoint = adjuntoId
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
  }, [pagoId, adjuntoId]);

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
