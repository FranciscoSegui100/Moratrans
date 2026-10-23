import { Printer, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { formatearFecha } from '../lib/fechas';

export interface ParadaHojaRuta {
  id: string;
  orden: number;
  tipo: 'entrega' | 'retiro' | 'recambio' | 'vaciado';
  direccion: string | null;
  contenedorNumero?: string | null;
  contenedorRetiro?: string | null; // en caso de recambio
  clienteNombre?: string | null;
  clienteTelefono?: string | null;
  horario?: string | null;
  notas?: string | null;
  remito?: string | null;
  importe?: number | null;
  medioPago?: string | null;
  esCuentaCorriente?: boolean;
  pagoEstado?: string | null;
  completada?: boolean;
}

interface HojaRutaModalProps {
  rutaId: string;
  fecha: string;
  choferNombre: string | null;
  patente: string | null;
  paradas: ParadaHojaRuta[];
  onClose: () => void;
}

export function HojaRutaModal({
  fecha,
  choferNombre,
  patente,
  paradas,
  onClose,
}: HojaRutaModalProps) {
  function handlePrint() {
    window.print();
  }

  const totalEntregas = paradas.filter((p) => p.tipo === 'entrega' || p.tipo === 'recambio').length;
  const totalRetiros = paradas.filter((p) => p.tipo === 'retiro' || p.tipo === 'recambio').length;
  const totalVaciados = paradas.filter((p) => p.tipo === 'vaciado').length;
  const totalACobrarEfectivo = paradas.reduce((acc, p) => {
    if (p.medioPago === 'efectivo' && p.importe && p.pagoEstado !== 'aprobado') {
      return acc + p.importe;
    }
    return acc;
  }, 0);

  const fechaImpresion = new Date().toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 9999 }}>
      <div
        className="modal-card hoja-ruta-modal-container"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '900px',
          width: '95vw',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          padding: '0',
          overflow: 'hidden',
          background: 'var(--bg-surface, #ffffff)',
          color: 'var(--text-primary, #0f172a)',
        }}
      >
        {/* Barra superior de acciones (se oculta al imprimir) */}
        <div
          className="no-print"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 20px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Printer size={18} className="text-accent" />
            <strong style={{ fontSize: '1rem' }}>Vista Previa de Hoja de Ruta</strong>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="btn btn-primary" onClick={handlePrint}>
              <Printer size={15} /> Imprimir / Guardar como PDF
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              <X size={16} /> Cerrar
            </button>
          </div>
        </div>

        {/* Contenido imprimible */}
        <div
          className="hoja-ruta-print-area"
          style={{
            padding: '30px',
            overflowY: 'auto',
            background: '#ffffff',
            color: '#1e293b',
            fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif",
          }}
        >
          {/* Encabezado formal */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              borderBottom: '2px solid #0f172a',
              paddingBottom: '16px',
              marginBottom: '20px',
            }}
          >
            <div>
              <div style={{ fontSize: '22px', fontWeight: 900, letterSpacing: '-0.5px', color: '#0f172a' }}>
                MORATRANS
              </div>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                Servicios Ambientales · Logística de Contenedores
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                Mendoza, Argentina · Tel: +54 9 261 000-0000
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div
                style={{
                  display: 'inline-block',
                  background: '#0f172a',
                  color: '#ffffff',
                  padding: '4px 12px',
                  borderRadius: '4px',
                  fontWeight: 800,
                  fontSize: '13px',
                  letterSpacing: '0.5px',
                  marginBottom: '6px',
                }}
              >
                HOJA DE RUTA DIARIA
              </div>
              <div style={{ fontSize: '13px', fontWeight: 700 }}>
                Fecha: {formatearFecha(fecha)}
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>
                Emitido: {fechaImpresion} hs
              </div>
            </div>
          </div>

          {/* Datos del chofer y vehículo */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '12px',
              padding: '12px 16px',
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '6px',
              marginBottom: '20px',
              fontSize: '12px',
            }}
          >
            <div>
              <span style={{ color: '#64748b', display: 'block', fontSize: '10px', textTransform: 'uppercase', fontWeight: 700 }}>
                Chofer Asignado
              </span>
              <strong style={{ fontSize: '13px', color: '#0f172a' }}>{choferNombre ?? 'Sin chofer'}</strong>
            </div>
            <div>
              <span style={{ color: '#64748b', display: 'block', fontSize: '10px', textTransform: 'uppercase', fontWeight: 700 }}>
                Patente Camión
              </span>
              <strong style={{ fontSize: '13px', color: '#0f172a' }}>{patente ?? '—'}</strong>
            </div>
            <div>
              <span style={{ color: '#64748b', display: 'block', fontSize: '10px', textTransform: 'uppercase', fontWeight: 700 }}>
                Total de Paradas
              </span>
              <strong style={{ fontSize: '13px', color: '#0f172a' }}>
                {paradas.length} ({totalEntregas} ent. / {totalRetiros} ret. / {totalVaciados} vac.)
              </strong>
            </div>
            <div>
              <span style={{ color: '#64748b', display: 'block', fontSize: '10px', textTransform: 'uppercase', fontWeight: 700 }}>
                Cobranza en Efectivo
              </span>
              <strong style={{ fontSize: '13px', color: totalACobrarEfectivo > 0 ? '#b91c1c' : '#15803d' }}>
                {totalACobrarEfectivo > 0 ? `$${totalACobrarEfectivo.toLocaleString('es-AR')}` : 'Sin cobranzas'}
              </strong>
            </div>
          </div>

          {/* Tabla de paradas */}
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '11px',
              marginBottom: '25px',
            }}
          >
            <thead>
              <tr style={{ background: '#0f172a', color: '#ffffff', textAlign: 'left' }}>
                <th style={{ padding: '8px 6px', width: '36px', textAlign: 'center', borderRadius: '4px 0 0 0' }}>#</th>
                <th style={{ padding: '8px 8px', width: '80px' }}>Tipo</th>
                <th style={{ padding: '8px 8px', width: '80px' }}>Contenedor</th>
                <th style={{ padding: '8px 8px' }}>Dirección / Destino</th>
                <th style={{ padding: '8px 8px', width: '130px' }}>Cliente / Teléfono</th>
                <th style={{ padding: '8px 8px', width: '90px' }}>Cobro ($)</th>
                <th style={{ padding: '8px 8px', width: '100px', borderRadius: '0 4px 0 0' }}>Firma / Conforme</th>
              </tr>
            </thead>
            <tbody>
              {paradas.map((p, idx) => {
                const esPar = idx % 2 === 1;
                const tieneCobro = p.medioPago === 'efectivo' && p.importe && p.pagoEstado !== 'aprobado';
                return (
                  <tr
                    key={p.id}
                    style={{
                      background: esPar ? '#f8fafc' : '#ffffff',
                      borderBottom: '1px solid #e2e8f0',
                      pageBreakInside: 'avoid',
                    }}
                  >
                    <td style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 800, fontSize: '12px' }}>
                      {p.orden}
                    </td>
                    <td style={{ padding: '8px 8px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '10px',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          background:
                            p.tipo === 'recambio'
                              ? '#ede9fe'
                              : p.tipo === 'entrega'
                              ? '#dcfce7'
                              : p.tipo === 'retiro'
                              ? '#fef3c7'
                              : '#e0f2fe',
                          color:
                            p.tipo === 'recambio'
                              ? '#6d28d9'
                              : p.tipo === 'entrega'
                              ? '#15803d'
                              : p.tipo === 'retiro'
                              ? '#b45309'
                              : '#0369a1',
                        }}
                      >
                        {p.tipo}
                      </span>
                    </td>
                    <td style={{ padding: '8px 8px', fontWeight: 700 }}>
                      {p.tipo === 'recambio' ? (
                        <>
                          <div style={{ color: '#15803d' }}>+ Dejar: {p.contenedorNumero ?? '—'}</div>
                          <div style={{ color: '#b45309' }}>- Retirar: {p.contenedorRetiro ?? '—'}</div>
                        </>
                      ) : (
                        p.contenedorNumero ?? '—'
                      )}
                    </td>
                    <td style={{ padding: '8px 8px' }}>
                      <div style={{ fontWeight: 600, color: '#0f172a' }}>{p.direccion ?? 'Sin dirección especificada'}</div>
                      {p.horario && (
                        <div style={{ fontSize: '10px', color: '#475569', marginTop: '2px' }}>
                          🕐 Horario pedido: {p.horario}
                        </div>
                      )}
                      {p.notas && (
                        <div style={{ fontSize: '10px', color: '#64748b', fontStyle: 'italic', marginTop: '1px' }}>
                          Nota: {p.notas}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '8px 8px' }}>
                      <div style={{ fontWeight: 600 }}>{p.clienteNombre ?? '—'}</div>
                      <div style={{ color: '#475569', fontSize: '10px' }}>{p.clienteTelefono ?? '—'}</div>
                    </td>
                    <td style={{ padding: '8px 8px' }}>
                      {tieneCobro ? (
                        <div style={{ color: '#b91c1c', fontWeight: 800, fontSize: '12px' }}>
                          ${p.importe?.toLocaleString('es-AR')}
                          <div style={{ fontSize: '9px', fontWeight: 600, color: '#ef4444' }}>COBRAR EFECTIVO</div>
                        </div>
                      ) : p.esCuentaCorriente ? (
                        <span style={{ color: '#0284c7', fontSize: '10px', fontWeight: 600 }}>Cta. Cte.</span>
                      ) : (
                        <span style={{ color: '#15803d', fontSize: '10px', fontWeight: 600 }}>✓ Pagado</span>
                      )}
                    </td>
                    <td style={{ padding: '8px 8px', textAlign: 'center' }}>
                      <div
                        style={{
                          height: '28px',
                          borderBottom: '1px dashed #94a3b8',
                          marginTop: '6px',
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Bloque de firmas y notas al pie */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '40px',
              marginTop: '40px',
              paddingTop: '20px',
              pageBreakInside: 'avoid',
            }}
          >
            <div style={{ textAlign: 'center' }}>
              <div style={{ borderBottom: '1px solid #475569', width: '70%', margin: '0 auto 8px auto' }} />
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#0f172a' }}>
                Firma del Chofer ({choferNombre ?? 'Chofer'})
              </div>
              <div style={{ fontSize: '10px', color: '#64748b' }}>Recibí conforme unidades y remitos</div>
            </div>

            <div style={{ textAlign: 'center' }}>
              <div style={{ borderBottom: '1px solid #475569', width: '70%', margin: '0 auto 8px auto' }} />
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#0f172a' }}>
                Despachante / Control de Salida
              </div>
              <div style={{ fontSize: '10px', color: '#64748b' }}>Moratrans Logística</div>
            </div>
          </div>

          {/* Aviso operativo al pie */}
          <div
            style={{
              marginTop: '25px',
              borderTop: '1px solid #e2e8f0',
              paddingTop: '10px',
              fontSize: '10px',
              color: '#94a3b8',
              textAlign: 'center',
            }}
          >
            * En caso de rotura, demora o anomalía en destino, comunicarse de inmediato con la central de operaciones.
          </div>
        </div>

        {/* CSS para la impresión */}
        <style>{`
          @media print {
            body * {
              visibility: hidden;
            }
            .hoja-ruta-print-area, .hoja-ruta-print-area * {
              visibility: visible;
            }
            .hoja-ruta-print-area {
              position: absolute;
              left: 0;
              top: 0;
              width: 100%;
              margin: 0;
              padding: 15mm !important;
              background: #ffffff !important;
              color: #000000 !important;
            }
            .no-print {
              display: none !important;
            }
            .modal-backdrop {
              position: static !important;
              background: none !important;
              padding: 0 !important;
            }
            .modal-card {
              box-shadow: none !important;
              border: none !important;
              width: 100% !important;
              max-width: none !important;
            }
          }
        `}</style>
      </div>
    </div>
  );
}
