import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Camera } from 'lucide-react';
import { api } from '../api/client';
import { useToast } from './Toast';
import { ComprobanteViewer } from './ComprobanteViewer';

interface Contenedor { numero: string; estado: string; tamano: number | null; }

/** "c 14", "C-014" -> "C014": para comparar sin guiones, espacios ni mayúsculas. */
function clave(texto: string): string {
  return texto.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function distancia(a: string, b: string): number {
  const fila = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const arriba = fila[j];
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = arriba;
    }
  }
  return fila[b.length];
}

/**
 * Qué tan parecido es `numero` a lo que escribió el chofer (menor = más
 * parecido; null = no se sugiere). Cubre los errores típicos de tipeo: una o
 * dos teclas de diferencia, ceros de más o de menos, dígitos invertidos.
 */
function parecido(numero: string, informado: string): number | null {
  const a = clave(numero);
  const b = clave(informado);
  if (!b) return null;
  const digA = a.replace(/\D/g, '').replace(/^0+/, '');
  const digB = b.replace(/\D/g, '').replace(/^0+/, '');
  if (digA && digA === digB) return 0;
  const d = distancia(a, b);
  if (d <= 2) return d;
  if (digA && digA.length === digB.length && [...digA].sort().join('') === [...digB].sort().join('')) return 2;
  return null;
}

/**
 * Entrega "a verificar": el chofer escribió un contenedor que no existe o no
 * estaba disponible, y la entrega se registró sin contenedor. Acá la oficina
 * le asigna el correcto — solo de los disponibles, así que siempre termina
 * con uno válido. Si existe de verdad pero nunca se cargó, se da de alta y
 * se asigna en el mismo paso.
 */
export function AsignarContenedorModal({
  viajeId,
  informado,
  detalle,
  onClose,
}: {
  viajeId: string;
  informado: string | null;
  detalle?: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [busqueda, setBusqueda] = useState('');
  const [elegido, setElegido] = useState('');
  const [verFoto, setVerFoto] = useState(false);
  const [altaAbierta, setAltaAbierta] = useState(false);
  const [altaNumero, setAltaNumero] = useState(informado ?? '');
  const [altaTamano, setAltaTamano] = useState('');
  const [guardando, setGuardando] = useState(false);

  const { data: contenedores = [], isLoading } = useQuery({
    queryKey: ['contenedores'],
    queryFn: () => api.get<Contenedor[]>('/api/contenedores').then((r) => r.data),
  });
  const disponibles = useMemo(() => contenedores.filter((c) => c.estado === 'disponible'), [contenedores]);

  const sugeridos = useMemo(() => {
    if (!informado) return [];
    return disponibles
      .map((c) => ({ c, d: parecido(c.numero, informado) }))
      .filter((x): x is { c: Contenedor; d: number } => x.d !== null)
      .sort((x, y) => x.d - y.d)
      .slice(0, 6)
      .map((x) => x.c);
  }, [disponibles, informado]);

  const filtrados = useMemo(() => {
    const q = clave(busqueda);
    return (q ? disponibles.filter((c) => clave(c.numero).includes(q)) : disponibles).slice(0, 50);
  }, [disponibles, busqueda]);

  function etiqueta(c: Contenedor) {
    return c.tamano ? `${c.numero} (${c.tamano} m³)` : c.numero;
  }

  async function asignar(numero: string) {
    setGuardando(true);
    try {
      await api.post(`/api/viajes/${viajeId}/asignar-contenedor`, { contenedor_numero: numero });
      queryClient.invalidateQueries({ queryKey: ['viajes'] });
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      queryClient.invalidateQueries({ queryKey: ['contenedores'] });
      show('success', 'Contenedor asignado', `${numero} quedó entregado a este cliente`);
      onClose();
    } catch (err: any) {
      show('error', 'No se pudo asignar', err.response?.data?.error);
    } finally {
      setGuardando(false);
    }
  }

  async function darDeAltaYAsignar() {
    if (!altaNumero.trim() || !altaTamano) return;
    setGuardando(true);
    try {
      const { data } = await api.post<Contenedor>('/api/contenedores', { numero: altaNumero.trim(), tamano: Number(altaTamano) });
      await asignar(data.numero);
    } catch (err: any) {
      show('error', 'No se pudo dar de alta', err.response?.data?.error);
      setGuardando(false);
    }
  }

  const fila = (c: Contenedor) => (
    <button
      key={c.numero}
      type="button"
      className={`btn btn-sm ${elegido === c.numero ? 'btn-primary' : 'btn-ghost'}`}
      style={{ justifyContent: 'flex-start', fontFamily: 'var(--font-mono, monospace)' }}
      onClick={() => setElegido(c.numero)}
    >
      {etiqueta(c)}
    </button>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <div className="section-title" style={{ margin: 0 }}>Asignar contenedor</div>
          <button className="modal-close" onClick={onClose}><X size={18} strokeWidth={2} /></button>
        </div>

        <p style={{ fontSize: '0.85rem', marginTop: 0 }}>
          {informado
            ? <>El chofer escribió <strong className="mono">{informado}</strong>, pero no existe o no estaba disponible.</>
            : <>El chofer registró la entrega sin un contenedor válido.</>}
          {' '}Elegí el que dejó de verdad.
          {detalle && <span style={{ display: 'block', color: 'var(--text-muted)', marginTop: 4 }}>{detalle}</span>}
        </p>

        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVerFoto((v) => !v)} style={{ marginBottom: 10 }}>
          <Camera size={14} strokeWidth={1.75} /> {verFoto ? 'Ocultar foto de la entrega' : 'Ver foto de la entrega'}
        </button>
        {verFoto && <div style={{ marginBottom: 12 }}><ComprobanteViewer viajeFotoId={viajeId} /></div>}

        {sugeridos.length > 0 && (
          <div className="form-group">
            <label className="form-label">Parecidos a lo que escribió</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{sugeridos.map(fila)}</div>
          </div>
        )}

        <div className="form-group">
          <label className="form-label" htmlFor="asignar-buscar">Buscar entre los disponibles ({disponibles.length})</label>
          <input
            id="asignar-buscar"
            className="form-input"
            placeholder="Número del contenedor"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, maxHeight: 180, overflowY: 'auto' }}>
            {isLoading
              ? <span className="text-muted">Cargando…</span>
              : filtrados.length === 0
                ? <span className="text-muted">No hay disponibles con ese número.</span>
                : filtrados.map(fila)}
          </div>
        </div>

        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          disabled={!elegido || guardando}
          onClick={() => asignar(elegido)}
        >
          {guardando ? 'Asignando…' : elegido ? `Asignar ${elegido}` : 'Elegí un contenedor'}
        </button>

        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12 }}>
          {!altaAbierta ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAltaAbierta(true)}>
              ¿Existe pero no está cargado? Dar de alta
            </button>
          ) : (
            <div className="form-row" style={{ alignItems: 'flex-end', gap: 8 }}>
              <div className="form-group" style={{ flex: 2 }}>
                <label className="form-label" htmlFor="asignar-alta-numero">Número</label>
                <input id="asignar-alta-numero" className="form-input" value={altaNumero} onChange={(e) => setAltaNumero(e.target.value)} />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label" htmlFor="asignar-alta-tamano">Tamaño</label>
                <select id="asignar-alta-tamano" className="form-select" value={altaTamano} onChange={(e) => setAltaTamano(e.target.value)}>
                  <option value="">—</option>
                  <option value="5">5 m³</option>
                  <option value="7">7 m³</option>
                  <option value="9">9 m³</option>
                </select>
              </div>
              <button
                className="btn btn-success"
                disabled={!altaNumero.trim() || !altaTamano || guardando}
                onClick={darDeAltaYAsignar}
                style={{ marginBottom: 'var(--space-3, 12px)' }}
              >
                Dar de alta y asignar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
