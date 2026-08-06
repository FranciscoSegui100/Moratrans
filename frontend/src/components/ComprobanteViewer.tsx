import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../api/client';

/** Descarga el comprobante autenticado (Bearer) y lo muestra como imagen o link a PDF. */
export function ComprobanteViewer({ pagoId }: { pagoId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [esPdf, setEsPdf] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelado = false;

    api
      .get(`/api/pagos/${pagoId}/comprobante`, { responseType: 'blob' })
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
  }, [pagoId]);

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
