import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Send, Pencil, X } from 'lucide-react';
import { api, descargarArchivo } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { DireccionMaps } from '../components/DireccionMaps';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { useAuth, tieneRol } from '../context/AuthContext';
import { formatearFecha } from '../lib/fechas';

interface Comprobante {
  id: string;
  tipo: string;
  monto: string | null;
  estado: string;
  es_cuenta_corriente: boolean;
  tiene_comprobante: boolean;
  titular: string | null;
  creado_en: string;
}

interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  cuenta_corriente_estado: 'sin_pedir' | 'pendiente' | 'aprobada' | 'rechazada';
  numero_plan: number | null;
}

interface ViajeCliente {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  estado: string;
  zona: string | null;
  contenedor_numero?: string | null;
  destino_direccion: string | null;
  destino_lat?: string | null;
  destino_lng?: string | null;
  patente: string | null;
  remito: string | null;
  importe: string | null;
  grupo_id: string | null;
  chofer_nombre: string | null;
  es_cuenta_corriente?: boolean;
  comprobantes?: Comprobante[];
}

const ETIQUETA_CC: Record<Cliente['cuenta_corriente_estado'], { texto: string; clase: string }> = {
  sin_pedir: { texto: 'Sin pedir', clase: 'retirado' },
  pendiente: { texto: 'Pendiente', clase: 'pendiente' },
  aprobada: { texto: 'Aprobada', clase: 'disponible' },
  rechazada: { texto: 'Rechazada', clase: 'rechazado' },
};

/** Mismo criterio que excelClientes() en el backend — mantener en sync. */
function tipoBulto(v: ViajeCliente): string {
  if (v.tipo === 'entrega') return 'VACIO';
  if (v.grupo_id) return 'Recambio';
  return 'Retiro';
}

function etiquetaMes(mes: string): string {
  const [anio, m] = mes.split('-');
  const texto = new Date(Number(anio), Number(m) - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// TEMPORAL: viajes de ejemplo para previsualizar cómo queda la tabla con
// datos de un cliente de cuenta corriente activo. Sacar cuando ya no haga falta.
function viajesDeEjemplo(): ViajeCliente[] {
  const hoy = new Date().toISOString().slice(0, 10);
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const hace2 = new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10);
  return [
    { id: 'd-01', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Montevideo', destino_direccion: 'Av. Italia 3200, Montevideo', patente: 'SBC1234', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Carlos Méndez' },
    { id: 'd-02', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Montevideo', destino_direccion: 'Bvar. Artigas 1850, Montevideo', patente: 'SBC1234', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Carlos Méndez' },
    { id: 'd-03', tipo: 'retiro', fecha: hoy, estado: 'programado', zona: 'Montevideo', destino_direccion: 'Rambla Rep. del Perú 1100', patente: 'SBC1234', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Carlos Méndez' },
    { id: 'd-04', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Canelones', destino_direccion: 'Ruta 5 km 28, Las Piedras', patente: 'TAD5678', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Roberto Silva' },
    { id: 'd-05', tipo: 'retiro', fecha: hoy, estado: 'programado', zona: 'Canelones', destino_direccion: 'Av. Giannattasio km 22, Ciudad de la Costa', patente: 'TAD5678', remito: null, importe: null, grupo_id: 'g-01', chofer_nombre: 'Roberto Silva' },
    { id: 'd-06', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Canelones', destino_direccion: 'Av. Giannattasio km 22, Ciudad de la Costa', patente: 'TAD5678', remito: null, importe: null, grupo_id: 'g-01', chofer_nombre: 'Roberto Silva' },
    { id: 'd-07', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Maldonado', destino_direccion: 'Av. Roosevelt 4500, Punta del Este', patente: 'UEF9012', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Diego Fernández' },
    { id: 'd-08', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Maldonado', destino_direccion: 'Ruta 39 km 5, San Carlos', patente: 'UEF9012', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Diego Fernández' },
    { id: 'd-09', tipo: 'retiro', fecha: hoy, estado: 'programado', zona: 'Maldonado', destino_direccion: 'Calle 20 esq. 25, Punta del Este', patente: 'UEF9012', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Diego Fernández' },
    { id: 'd-10', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Colonia', destino_direccion: 'Av. Artigas 580, Colonia del Sacramento', patente: 'SBC1234', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Carlos Méndez' },
    { id: 'd-11', tipo: 'retiro', fecha: hoy, estado: 'programado', zona: 'San José', destino_direccion: 'Ruta 1 km 98, San José de Mayo', patente: 'TAD5678', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Roberto Silva' },
    { id: 'd-12', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Soriano', destino_direccion: 'Calle 18 de Julio 320, Mercedes', patente: 'VGH3456', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Martín López' },
    { id: 'd-13', tipo: 'retiro', fecha: hoy, estado: 'programado', zona: 'Soriano', destino_direccion: 'Av. Asencio 1200, Mercedes', patente: 'VGH3456', remito: null, importe: null, grupo_id: 'g-02', chofer_nombre: 'Martín López' },
    { id: 'd-14', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Soriano', destino_direccion: 'Av. Asencio 1200, Mercedes', patente: 'VGH3456', remito: null, importe: null, grupo_id: 'g-02', chofer_nombre: 'Martín López' },
    { id: 'd-15', tipo: 'entrega', fecha: hoy, estado: 'programado', zona: 'Paysandú', destino_direccion: 'Av. España 950, Paysandú', patente: 'VGH3456', remito: null, importe: null, grupo_id: null, chofer_nombre: 'Martín López' },
    { id: 'd-16', tipo: 'retiro', fecha: ayer, estado: 'entregado', zona: 'Montevideo', destino_direccion: 'Av. 8 de Octubre 3100', patente: 'SBC1234', remito: 'R-2001', importe: '18500', grupo_id: null, chofer_nombre: 'Carlos Méndez' },
    { id: 'd-17', tipo: 'entrega', fecha: ayer, estado: 'entregado', zona: 'Montevideo', destino_direccion: 'Cno. Maldonado 5200', patente: 'TAD5678', remito: 'R-2002', importe: '22000', grupo_id: null, chofer_nombre: 'Roberto Silva' },
    { id: 'd-18', tipo: 'entrega', fecha: hace2, estado: 'entregado', zona: 'Canelones', destino_direccion: 'Ruta 8 km 32, Pando', patente: 'UEF9012', remito: 'R-1998', importe: '16000', grupo_id: null, chofer_nombre: 'Diego Fernández' },
    { id: 'd-19', tipo: 'retiro', fecha: hace2, estado: 'entregado', zona: 'Maldonado', destino_direccion: 'Av. Pedragosa Sierra 600, Maldonado', patente: 'UEF9012', remito: 'R-1999', importe: '25000', grupo_id: null, chofer_nombre: 'Diego Fernández' },
    { id: 'd-20', tipo: 'entrega', fecha: hace2, estado: 'entregado', zona: 'Colonia', destino_direccion: 'Ruta 1 km 177, Nueva Helvecia', patente: 'VGH3456', remito: 'R-2000', importe: '19500', grupo_id: null, chofer_nombre: 'Martín López' },
  ];
}

export function ClienteDetalle() {
  const { telefono = '' } = useParams<{ telefono: string }>();
  const { show } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const puedeEditarRemito = tieneRol(user, 'admin', 'operador', 'finanzas');
  const [enviando, setEnviando] = useState(false);
  const [editandoRemito, setEditandoRemito] = useState<string | null>(null);
  const [remitoForm, setRemitoForm] = useState('');
  const [viajeComprobantes, setViajeComprobantes] = useState<ViajeCliente | null>(null);
  const [reenviando, setReenviando] = useState<string | null>(null);

  /**
   * Para el caso borde en que un alargue de retiro quedó validado (pago +
   * vence_en ya corridos) pero el WhatsApp de confirmación nunca le llegó al
   * cliente — reintenta solo el envío, sin tocar nada ya grabado.
   */
  async function reenviarAvisoAlargue(pagoId: string) {
    setReenviando(pagoId);
    try {
      await api.post(`/api/pagos/${pagoId}/reenviar-aviso-alargue`);
      show('success', 'Aviso reenviado por WhatsApp');
    } catch (err: any) {
      show('error', 'No se pudo reenviar', err.response?.data?.error);
    } finally {
      setReenviando(null);
    }
  }

  async function guardarRemito(viajeId: string) {
    try {
      await api.patch(`/api/viajes/${viajeId}`, { remito: remitoForm.trim() || null });
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'viajes'] });
      setEditandoRemito(null);
      show('success', 'Nº de remito actualizado');
    } catch (err: any) {
      show('error', 'No se pudo guardar', err.response?.data?.error);
    }
  }

  async function enviarPorWhatsApp() {
    setEnviando(true);
    try {
      await api.post(`/api/clientes/${encodeURIComponent(telefono)}/enviar-excel`);
      show('success', 'Enviado por WhatsApp', telefono);
    } catch (err: any) {
      show('error', 'No se pudo enviar', err.response?.data?.error);
    } finally {
      setEnviando(false);
    }
  }

  const { data: clientes = [] } = useQuery({
    queryKey: ['clientes'],
    queryFn: () => api.get<Cliente[]>('/api/clientes').then((r) => r.data),
  });
  const cliente = clientes.find((c) => c.telefono === telefono);

  const { data: viajesReales = [] } = useQuery({
    queryKey: ['clientes', telefono, 'viajes'],
    queryFn: () => api.get<ViajeCliente[]>(`/api/clientes/${encodeURIComponent(telefono)}/viajes`).then((r) => r.data),
    enabled: !!telefono,
  });
  // TEMPORAL: si todavía no tiene viajes reales, se muestran de ejemplo
  // para previsualizar cómo queda la tabla con datos. BORRAR cuando ya no haga falta.
  const esCC = cliente?.cuenta_corriente_estado === 'aprobada' || cliente?.cuenta_corriente_estado === 'pendiente';
  const usandoDemo = viajesReales.length === 0;
  const viajes = usandoDemo ? viajesDeEjemplo() : viajesReales;

  // Ya vienen ordenados por fecha DESC desde el backend: agrupar preservando
  // ese orden deja los meses más recientes arriba sin tener que reordenar.
  const grupos = useMemo(() => {
    const porMes = new Map<string, ViajeCliente[]>();
    for (const v of viajes) {
      const mes = v.fecha.slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, []);
      porMes.get(mes)!.push(v);
    }
    return [...porMes.entries()];
  }, [viajes]);

  const cc = cliente ? ETIQUETA_CC[cliente.cuenta_corriente_estado] : null;

  return (
    <div>
      <div className="page-header">
        <Link to="/clientes" className="btn btn-ghost btn-sm" style={{ marginBottom: '10px' }}>
          <ArrowLeft size={14} strokeWidth={1.75} /> Volver a Clientes
        </Link>
        <h2>{cliente?.nombre ?? telefono}</h2>
        <p>
          {telefono}
          {cliente?.numero_plan != null && <> · Nº plan {cliente.numero_plan}</>}
          {cc && <> · <span className={`badge ${cc.clase}`}>{cc.texto}</span></>}
        </p>
      </div>

      <div className="form-card" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          className="btn btn-primary"
          onClick={() => descargarArchivo(`/api/clientes/export.xlsx?telefono=${encodeURIComponent(telefono)}`, `${cliente?.nombre ?? telefono}.xlsx`)}
        >
          <Download strokeWidth={1.75} /> Exportar a Excel
        </button>
        <RoleGate roles={['admin', 'operador', 'finanzas']}>
          <button className="btn btn-ghost" onClick={enviarPorWhatsApp} disabled={enviando}>
            <Send strokeWidth={1.75} /> {enviando ? 'Enviando...' : 'Enviar por WhatsApp'}
          </button>
        </RoleGate>
      </div>

      {grupos.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-title">Sin viajes registrados</div>
          </div>
        </div>
      ) : (
        grupos.map(([mes, viajesDelMes]) => (
          <div key={mes} style={{ marginTop: '20px' }}>
            <div className="section-title">{etiquetaMes(mes)}</div>
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>FECHA</th><th>CHA/EQU</th><th>PAT</th><th>POSICIÓN</th>
                    <th>TIPO BULTO</th><th>CANTIDAD</th><th>Nº REMITO</th>
                    <th>IMPORTE</th><th>COMPROBANTES</th><th>CHOFER</th><th>ESTADO</th>
                  </tr>
                </thead>
                <tbody>
                  {viajesDelMes.map((v) => (
                    <tr key={v.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatearFecha(v.fecha)}</td>
                      <td>Contenedor</td>
                      <td className="mono">{v.patente ?? '—'}</td>
                      <td>
                        {v.destino_direccion
                          ? <DireccionMaps direccion={v.destino_direccion} lat={v.destino_lat} lng={v.destino_lng} />
                          : (v.zona ?? '—')}
                      </td>
                      <td>{tipoBulto(v)}</td>
                      <td>1</td>
                      <td className="mono">
                        {editandoRemito === v.id ? (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input
                              className="form-input"
                              style={{ width: '90px', padding: '4px 8px' }}
                              value={remitoForm}
                              onChange={(e) => setRemitoForm(e.target.value)}
                              autoFocus
                            />
                            <button className="btn btn-success btn-sm" onClick={() => guardarRemito(v.id)}>OK</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setEditandoRemito(null)}>✕</button>
                          </div>
                        ) : puedeEditarRemito && !usandoDemo ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => { setEditandoRemito(v.id); setRemitoForm(v.remito ?? ''); }}
                          >
                            {v.remito ?? <span className="text-muted">Asignar</span>} <Pencil size={11} strokeWidth={1.75} />
                          </button>
                        ) : (
                          v.remito ?? '—'
                        )}
                      </td>
                      <td>{v.importe ? `$${Number(v.importe).toLocaleString('es-AR')}` : <span className="text-muted">—</span>}</td>
                      <td>
                        {(() => {
                          const comprobantes = v.comprobantes ?? [];
                          const inicial = comprobantes.find((c) => c.tipo !== 'alargue_retiro');
                          const extensiones = comprobantes.filter((c) => c.tipo === 'alargue_retiro');
                          const esCC = v.es_cuenta_corriente || inicial?.es_cuenta_corriente;
                          if (!esCC && !inicial && extensiones.length === 0) {
                            return <span className="text-muted">—</span>;
                          }
                          return (
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                              {esCC ? (
                                <span className="badge pendiente">📋 Cuenta corriente</span>
                              ) : inicial && (
                                <button className="btn btn-ghost btn-sm" onClick={() => setViajeComprobantes(v)}>
                                  🧾 Inicial
                                </button>
                              )}
                              {extensiones.length > 0 && (
                                <button className="btn btn-ghost btn-sm" onClick={() => setViajeComprobantes(v)}>
                                  ⏳ Extensión{extensiones.length > 1 ? ` (${extensiones.length})` : ''}
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td>{v.chofer_nombre ?? '—'}</td>
                      <td><span className={`badge ${v.estado}`}>{v.estado}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {viajeComprobantes && (
        <div className="modal-overlay" onClick={() => setViajeComprobantes(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="section-title" style={{ margin: 0 }}>
                Comprobantes · {viajeComprobantes.contenedor_numero ?? viajeComprobantes.tipo}
              </div>
              <button className="modal-close" onClick={() => setViajeComprobantes(null)}>
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            <p className="text-muted" style={{ marginTop: 0 }}>
              {formatearFecha(viajeComprobantes.fecha)} · {viajeComprobantes.destino_direccion ?? viajeComprobantes.zona ?? '—'}
            </p>
            {(viajeComprobantes.comprobantes ?? []).length === 0 && (
              <p className="text-muted">Sin comprobantes asociados a este viaje.</p>
            )}
            {(viajeComprobantes.comprobantes ?? []).map((c) => (
              <div key={c.id} style={{ marginBottom: 18 }}>
                <div className="section-title" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>
                    {c.tipo === 'alargue_retiro' ? '⏳ Extensión de retiro' : '🧾 Pago inicial'}
                    {c.monto && ` · $${Number(c.monto).toLocaleString('es-AR')}`}
                    {' · '}<span className={`badge ${c.estado}`}>{c.estado}</span>
                  </span>
                  {c.tipo === 'alargue_retiro' && c.estado === 'validado' && (
                    <RoleGate roles={['admin', 'operador', 'finanzas']}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => reenviarAvisoAlargue(c.id)}
                        disabled={reenviando === c.id}
                        title="Si el cliente dice que todavía no le llegó la confirmación por WhatsApp"
                      >
                        <Send size={12} strokeWidth={1.75} /> Reenviar aviso
                      </button>
                    </RoleGate>
                  )}
                </div>
                {c.titular && <p className="text-muted" style={{ margin: '0 0 6px' }}>Titular: {c.titular}</p>}
                {c.tiene_comprobante ? (
                  <ComprobanteViewer pagoId={c.id} />
                ) : (
                  <span className="text-muted">Sin archivo adjunto (cuenta corriente)</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
