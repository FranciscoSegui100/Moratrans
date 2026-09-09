import { useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Send, Pencil, Check, X, Wallet, Receipt, CircleDollarSign, Plus, Trash2 } from 'lucide-react';
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
  medio_pago: 'transferencia' | 'efectivo';
  efectivo_cobrado: boolean;
  creado_en: string;
}

interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  cuenta_corriente_estado: 'sin_pedir' | 'pendiente' | 'aprobada' | 'rechazada';
  numero_plan: number | null;
  cantidad_viajes: number;
}

interface Tarifa {
  departamento: string;
  precio: string;
  activo: boolean;
}

interface ItemDeuda {
  fecha: string;
  contenedor_numero: string | null;
  concepto: string;
  monto: string | null;
}

interface ResumenDeuda {
  items: ItemDeuda[];
  total: number;
}

interface ItemCuentaCorriente {
  fecha: string;
  zona: string | null;
  monto: string | null;
}

interface AbonoCuentaCorriente {
  id: string;
  fecha: string;
  monto: string | null;
  tiene_comprobante: boolean;
}

interface ResumenCuentaCorriente {
  cargos: ItemCuentaCorriente[];
  abonos: AbonoCuentaCorriente[];
  totalCargos: number;
  totalAbonos: number;
  saldo: number;
}

interface ViajeCliente {
  id: string;
  tipo: 'entrega' | 'retiro' | 'alargue_retiro';
  fecha: string;
  estado: string;
  zona: string | null;
  contenedor_numero?: string | null;
  destino_direccion: string | null;
  destino_lat?: string | null;
  destino_lng?: string | null;
  remito: string | null;
  importe: string | null;
  grupo_id: string | null;
  chofer_nombre: string | null;
  es_cuenta_corriente?: boolean;
  vence_en: string | null;
  comprobantes?: Comprobante[];
}

const ETIQUETA_CC: Record<Cliente['cuenta_corriente_estado'], { texto: string; clase: string }> = {
  sin_pedir: { texto: 'Ocasional', clase: 'retirado' },
  pendiente: { texto: 'Cuenta corriente (pendiente de aprobar)', clase: 'pendiente' },
  aprobada: { texto: 'Cuenta corriente', clase: 'disponible' },
  rechazada: { texto: 'Ocasional (cta. cte. rechazada)', clase: 'rechazado' },
};

/** Mismo criterio que excelClientes() en el backend — mantener en sync. */
function tipoBulto(v: ViajeCliente): string {
  if (v.tipo === 'alargue_retiro') return 'Extensión de retiro';
  if (v.tipo === 'entrega') return 'VACIO';
  if (v.grupo_id) return 'Recambio';
  return 'Retiro';
}

function etiquetaMes(mes: string): string {
  const [anio, m] = mes.split('-');
  const texto = new Date(Number(anio), Number(m) - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Mismo valor que PORCENTAJE_ALARGUE en backend/src/config/bot.config.ts — mantener en sync. */
const PORCENTAJE_ALARGUE = 0.5;

interface ViajeManualForm {
  tipo: 'entrega' | 'recambio' | 'alargue_retiro';
  fecha: string;
  contenedor_numero: string;
  contenedor_numero_entrega: string;
  importe: string;
  medio_pago: 'efectivo' | 'transferencia';
  pagado: boolean;
}

function formularioViajeVacio(): ViajeManualForm {
  return {
    tipo: 'entrega',
    fecha: new Date().toISOString().slice(0, 10),
    contenedor_numero: '',
    contenedor_numero_entrega: '',
    importe: '',
    medio_pago: 'transferencia',
    pagado: true,
  };
}

/** Lee un File como base64 puro (sin el prefijo "data:mime;base64,") para mandarlo en el body del POST. */
function archivoABase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ClienteDetalle() {
  const { telefono = '' } = useParams<{ telefono: string }>();
  const navigate = useNavigate();
  const { show } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const puedeEditarRemito = tieneRol(user, 'admin', 'operador', 'finanzas');
  const [enviando, setEnviando] = useState(false);
  const [editandoRemito, setEditandoRemito] = useState<string | null>(null);
  const [remitoForm, setRemitoForm] = useState('');
  const [viajeComprobantes, setViajeComprobantes] = useState<ViajeCliente | null>(null);
  const [comprobanteAbono, setComprobanteAbono] = useState<{ id: string; fecha: string; monto: number } | null>(null);
  const [reenviando, setReenviando] = useState<string | null>(null);
  const [editandoAbono, setEditandoAbono] = useState<string | null>(null);
  const [montoAbonoForm, setMontoAbonoForm] = useState('');
  const [agregandoPago, setAgregandoPago] = useState(false);
  const [montoPagoForm, setMontoPagoForm] = useState('');
  const [guardandoPago, setGuardandoPago] = useState(false);
  const [mostrarCargarViaje, setMostrarCargarViaje] = useState(false);
  const [viajeForm, setViajeForm] = useState<ViajeManualForm>(formularioViajeVacio());
  const [comprobanteFile, setComprobanteFile] = useState<File | null>(null);
  const [guardandoViaje, setGuardandoViaje] = useState(false);

  /**
   * Para el caso borde en que un pago (o alargue) quedó validado pero el
   * WhatsApp de confirmación nunca le llegó al cliente — reintenta solo el
   * envío, sin tocar nada ya grabado.
   */
  async function reenviarAviso(pagoId: string) {
    setReenviando(pagoId);
    try {
      await api.post(`/api/pagos/${pagoId}/reenviar-aviso`);
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

  /** Corrige el monto de un abono ya validado (ver POST /api/pagos/:id/monto) — para cuando el operador se equivocó al tipearlo. */
  async function guardarMontoAbono(abonoId: string) {
    const monto = Number(montoAbonoForm);
    if (!(monto > 0)) return show('error', 'Monto inválido');
    try {
      await api.patch(`/api/pagos/${abonoId}/monto`, { monto });
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'cuenta-corriente'] });
      setEditandoAbono(null);
      show('success', 'Monto corregido');
    } catch (err: any) {
      show('error', 'No se pudo guardar', err.response?.data?.error);
    }
  }

  /** Borra un abono cargado por error (ver DELETE /api/pagos/:id) — solo pagos, nunca cobros. */
  async function eliminarAbono(abonoId: string, monto: number) {
    if (!confirm(`¿Eliminar este pago de $${monto.toLocaleString('es-AR')}? Se vuelve a sumar al saldo pendiente.`)) return;
    try {
      await api.delete(`/api/pagos/${abonoId}`);
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'cuenta-corriente'] });
      show('success', 'Pago eliminado');
    } catch (err: any) {
      show('error', 'No se pudo eliminar', err.response?.data?.error);
    }
  }

  /** Marca a mano si un pago en efectivo ya fue cobrado (por el chofer al entregar) o no. */
  async function marcarCobrado(pagoId: string, cobrado: boolean) {
    try {
      await api.patch(`/api/pagos/${pagoId}/cobrado`, { cobrado });
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'viajes'] });
      show('success', cobrado ? 'Marcado como pagado' : 'Marcado como no pagado');
    } catch (err: any) {
      show('error', 'No se pudo actualizar', err.response?.data?.error);
    }
  }

  /** Pago que no pasó por WhatsApp (ej. efectivo en mano) — se acredita directo, sin comprobante. */
  async function agregarPagoManual() {
    const monto = Number(montoPagoForm);
    if (!(monto > 0)) return show('error', 'Monto inválido');
    setGuardandoPago(true);
    try {
      await api.post('/api/pagos/abono-manual', { telefono, monto });
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'cuenta-corriente'] });
      setAgregandoPago(false);
      setMontoPagoForm('');
      show('success', 'Pago acreditado a la cuenta corriente');
    } catch (err: any) {
      show('error', 'No se pudo guardar', err.response?.data?.error);
    } finally {
      setGuardandoPago(false);
    }
  }

  /**
   * Un cliente de cuenta corriente recibe el mismo PDF que puede pedir él
   * mismo con "📊 Resumen de cuenta" por WhatsApp (ver movimientos.flow.ts) —
   * tiene sentido que vea su historial completo, porque paga a fin de mes.
   * Un cliente OCASIONAL en cambio paga cada viaje por separado: no le sirve
   * ver un historial, solo le interesa si le quedó algo sin pagar (ver
   * enviar-resumen-deuda) — y si no tiene nada pendiente, ni se manda nada.
   */
  async function enviarResumenPorWhatsApp() {
    setEnviando(true);
    try {
      await api.post(`/api/clientes/${encodeURIComponent(telefono)}/${esCC ? 'enviar-resumen-cuenta' : 'enviar-resumen-deuda'}`);
      show('success', 'Enviado por WhatsApp', telefono);
    } catch (err: any) {
      show('error', 'No se pudo enviar', err.response?.data?.error);
    } finally {
      setEnviando(false);
    }
  }

  /**
   * Carga a mano un viaje/recambio/extensión de retiro ya realizado que no
   * pasó por el sistema (ver POST /api/clientes/:telefono/viaje-manual en el
   * backend para las reglas de plata: pagado nunca suma a cuenta corriente,
   * no pagado + ocasional manda la solicitud por WhatsApp, no pagado + cta.
   * cte. se agrega directo al resumen sin avisar nada).
   */
  async function cargarViajeManual() {
    if (viajeForm.tipo !== 'alargue_retiro' && !viajeForm.contenedor_numero.trim()) {
      return show('error', 'Falta el número de contenedor');
    }
    const importe = Number(viajeForm.importe);
    if (!(importe > 0)) return show('error', 'El importe tiene que ser mayor a 0');
    setGuardandoViaje(true);
    try {
      let comprobante_base64: string | undefined;
      let comprobante_content_type: string | undefined;
      if (viajeForm.pagado && viajeForm.medio_pago === 'transferencia' && comprobanteFile) {
        comprobante_base64 = await archivoABase64(comprobanteFile);
        comprobante_content_type = comprobanteFile.type;
      }
      await api.post(`/api/clientes/${encodeURIComponent(telefono)}/viaje-manual`, {
        tipo: viajeForm.tipo,
        fecha: viajeForm.fecha,
        contenedor_numero: viajeForm.contenedor_numero.trim() || undefined,
        contenedor_numero_entrega: viajeForm.tipo === 'recambio' && viajeForm.contenedor_numero_entrega.trim()
          ? viajeForm.contenedor_numero_entrega.trim() : undefined,
        importe,
        medio_pago: viajeForm.medio_pago,
        pagado: viajeForm.pagado,
        comprobante_base64,
        comprobante_content_type,
      });
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      show(
        'success',
        'Viaje cargado',
        !viajeForm.pagado && !esCC ? 'Se le mandó la solicitud de pago por WhatsApp.' : undefined,
      );
      setMostrarCargarViaje(false);
      setViajeForm(formularioViajeVacio());
      setComprobanteFile(null);
    } catch (err: any) {
      show('error', 'No se pudo cargar el viaje', err.response?.data?.error);
    } finally {
      setGuardandoViaje(false);
    }
  }

  /**
   * Cambia el tipo de cliente (aprobar/rechazar solicitud, dar de alta o
   * mover a ocasional) — antes vivía en la pestaña Clientes, ahora todo eso
   * se maneja desde acá. No borra ni recalcula nada de plata: el saldo de
   * cuenta corriente y la deuda ocasional quedan grabados en cada pago/viaje
   * (es_cuenta_corriente), así que cambiar el tipo no hace desaparecer
   * ninguna deuda vieja (ver GET /api/clientes en el backend).
   */
  async function cambiarCuentaCorriente(estado: Cliente['cuenta_corriente_estado']) {
    if (!cliente) return;
    try {
      await api.patch(`/api/clientes/${cliente.id}`, { cuenta_corriente_estado: estado });
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      show(
        'success',
        estado === 'aprobada' ? 'Cliente pasado a cuenta corriente'
          : estado === 'rechazada' ? 'Cliente pasado a ocasional'
          : 'Cliente actualizado',
      );
    } catch (err: any) {
      show('error', 'No se pudo actualizar', err.response?.data?.error);
    }
  }

  /** Baja definitiva del cliente — mismo endpoint que antes vivía en la lista de Clientes. */
  async function eliminarCliente() {
    if (!cliente) return;
    if (!confirm(`¿Eliminar a ${cliente.nombre}? No se puede deshacer.`)) return;
    try {
      await api.delete(`/api/clientes/${cliente.id}`);
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
      show('success', 'Cliente eliminado');
      navigate('/clientes');
    } catch (err: any) {
      show('error', 'No se pudo eliminar', err.response?.data?.error);
    }
  }

  const { data: clientes = [] } = useQuery({
    queryKey: ['clientes'],
    queryFn: () => api.get<Cliente[]>('/api/clientes').then((r) => r.data),
  });
  const cliente = clientes.find((c) => c.telefono === telefono);

  // Para autocompletar el importe al cargar un viaje a mano (ver modal más abajo).
  const { data: tarifas = [] } = useQuery({
    queryKey: ['tarifas'],
    queryFn: () => api.get<Tarifa[]>('/api/tarifas').then((r) => r.data),
  });

  const { data: viajesReales = [] } = useQuery({
    queryKey: ['clientes', telefono, 'viajes'],
    queryFn: () => api.get<ViajeCliente[]>(`/api/clientes/${encodeURIComponent(telefono)}/viajes`).then((r) => r.data),
    enabled: !!telefono,
  });
  const esCC = cliente?.cuenta_corriente_estado === 'aprobada' || cliente?.cuenta_corriente_estado === 'pendiente';

  // Se piden SIEMPRE las dos, sin importar el tipo actual del cliente: el
  // saldo de cuenta corriente y la deuda ocasional son cálculos
  // independientes del estado actual (ver comentario de cambiarCuentaCorriente
  // más arriba) — si un cliente cambió de tipo alguna vez, puede tener las
  // dos a la vez, y ninguna de las dos se puede dejar de mostrar.
  const { data: deuda } = useQuery({
    queryKey: ['clientes', telefono, 'deuda'],
    queryFn: () => api.get<ResumenDeuda>(`/api/clientes/${encodeURIComponent(telefono)}/deuda`).then((r) => r.data),
    enabled: !!telefono,
  });

  const { data: cuentaCorriente } = useQuery({
    queryKey: ['clientes', telefono, 'cuenta-corriente'],
    queryFn: () => api.get<ResumenCuentaCorriente>(`/api/clientes/${encodeURIComponent(telefono)}/cuenta-corriente`).then((r) => r.data),
    enabled: !!telefono,
  });

  const deudaTotal = Math.max(cuentaCorriente?.saldo ?? 0, 0) + (deuda?.total ?? 0);
  const viajes = viajesReales;

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <Link to="/clientes" className="btn btn-ghost btn-sm" style={{ margin: 0 }}>
            <ArrowLeft size={14} strokeWidth={1.75} /> Volver a Clientes
          </Link>
          <RoleGate roles={['admin', 'operador', 'finanzas']}>
            <button className="btn btn-danger btn-sm" onClick={eliminarCliente} title="Eliminar cliente">
              <Trash2 size={13} strokeWidth={1.75} /> Eliminar cliente
            </button>
          </RoleGate>
        </div>
        <h2>{cliente?.nombre ?? telefono}</h2>
        <p>
          {telefono}
          {cliente?.numero_plan != null && <> · Nº plan {cliente.numero_plan}</>}
        </p>
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '20px' }}>
        <div className="stat" style={{ flex: '1 1 160px' }}>
          <div className="l">Pedidos</div>
          <div className="n">{cliente?.cantidad_viajes ?? '—'}</div>
        </div>
        <div className="stat" style={{ flex: '1 1 220px' }}>
          <div className="l">Tipo de cliente</div>
          {cc && (
            <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span className={`badge ${cc.clase}`}>{cc.texto}</span>
              <RoleGate roles={['admin', 'operador', 'finanzas']}>
                {(cliente?.cuenta_corriente_estado === 'sin_pedir' || cliente?.cuenta_corriente_estado === 'rechazada') && (
                  <button className="btn btn-ghost btn-sm" onClick={() => cambiarCuentaCorriente('aprobada')}>
                    Cambiar a cliente cuenta corriente
                  </button>
                )}
                {cliente?.cuenta_corriente_estado === 'pendiente' && (
                  <>
                    <button className="btn btn-success btn-sm" onClick={() => cambiarCuentaCorriente('aprobada')}>
                      <Check size={13} strokeWidth={2} /> Aprobar
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => cambiarCuentaCorriente('rechazada')}>
                      <X size={13} strokeWidth={2} /> Rechazar
                    </button>
                  </>
                )}
                {cliente?.cuenta_corriente_estado === 'aprobada' && (
                  <button className="btn btn-ghost btn-sm" onClick={() => cambiarCuentaCorriente('rechazada')}>
                    Mover a cliente ocasional
                  </button>
                )}
              </RoleGate>
            </div>
          )}
        </div>
        <div className="stat" style={{ flex: '1 1 160px' }}>
          <div className="l">Deuda</div>
          <div className={`n${deudaTotal > 0 ? ' warn' : ''}`} style={{ fontSize: '1.15rem' }}>
            {!deuda && !cuentaCorriente ? '—' : deudaTotal > 0 ? `Sí · $${deudaTotal.toLocaleString('es-AR')}` : 'No'}
          </div>
        </div>
      </div>

      <div className="form-card" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          onClick={() => descargarArchivo(`/api/clientes/export.xlsx?telefono=${encodeURIComponent(telefono)}`, `pedidos-${cliente?.nombre ?? telefono}.xlsx`)}
        >
          <Download strokeWidth={1.75} /> Exportar pedidos de este cliente a Excel
        </button>
        <small className="text-muted">Incluye su resumen facturado por mes, su ficha, y el detalle de todos sus pedidos.</small>
        <RoleGate roles={['admin', 'operador', 'finanzas']}>
          <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setMostrarCargarViaje(true)}>
            <Plus strokeWidth={1.75} /> Cargar viaje finalizado
          </button>
        </RoleGate>
        <RoleGate roles={['admin', 'operador', 'finanzas']}>
          <button className="btn btn-ghost" onClick={enviarResumenPorWhatsApp} disabled={enviando}>
            <Send strokeWidth={1.75} />
            {' '}
            {enviando ? 'Enviando...' : esCC ? 'Enviar resumen de cuenta por WhatsApp' : 'Enviar deuda pendiente por WhatsApp'}
          </button>
        </RoleGate>
      </div>

      {cuentaCorriente && (esCC || cuentaCorriente.cargos.length > 0 || cuentaCorriente.abonos.length > 0) && (
        <div style={{ marginTop: '20px' }}>
          <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Cuenta corriente</span>
            <RoleGate roles={['admin', 'operador', 'finanzas']}>
              {agregandoPago ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="form-input"
                    style={{ width: '140px', padding: '4px 8px' }}
                    placeholder="Monto"
                    value={montoPagoForm}
                    onChange={(e) => setMontoPagoForm(e.target.value)}
                    autoFocus
                  />
                  <button className="btn btn-success btn-sm" onClick={agregarPagoManual} disabled={guardandoPago}>OK</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setAgregandoPago(false); setMontoPagoForm(''); }}>✕</button>
                </div>
              ) : (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setAgregandoPago(true)}
                  title="Para pagos que no pasaron por WhatsApp, ej. efectivo en mano"
                >
                  <Plus size={12} strokeWidth={1.75} /> Agregar pago manual
                </button>
              )}
            </RoleGate>
          </div>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-icon"><Receipt strokeWidth={1.75} /></div>
              <div className="kpi-value">${cuentaCorriente.totalCargos.toLocaleString('es-AR')}</div>
              <div className="kpi-label">Deuda acumulada</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-icon"><Wallet strokeWidth={1.75} /></div>
              <div className="kpi-value">${cuentaCorriente.totalAbonos.toLocaleString('es-AR')}</div>
              <div className="kpi-label">Pagado</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-icon"><CircleDollarSign strokeWidth={1.75} /></div>
              <div className="kpi-value">${cuentaCorriente.saldo.toLocaleString('es-AR')}</div>
              <div className="kpi-label">Saldo pendiente</div>
            </div>
          </div>

          {(cuentaCorriente.cargos.length > 0 || cuentaCorriente.abonos.length > 0) && (
            <div className="table-wrapper" style={{ marginTop: '12px' }}>
              <table className="data-table">
                <thead>
                  <tr><th>FECHA</th><th>MOVIMIENTO</th><th>MONTO</th></tr>
                </thead>
                <tbody>
                  {[
                    ...cuentaCorriente.cargos.map((c) => ({ id: null as string | null, fecha: c.fecha, texto: c.zona ?? 'Sin zona', monto: c.monto ? Number(c.monto) : 0, signo: 1, tieneComprobante: false })),
                    ...cuentaCorriente.abonos.map((a) => ({ id: a.id, fecha: a.fecha, texto: 'Pago acreditado', monto: a.monto ? Number(a.monto) : 0, signo: -1, tieneComprobante: a.tiene_comprobante })),
                  ]
                    .sort((a, b) => a.fecha.localeCompare(b.fecha))
                    .reverse()
                    .map((m, i) => (
                      <tr key={i}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatearFecha(m.fecha)}</td>
                        <td>{m.signo > 0 ? m.texto : <span style={{ color: 'var(--color-success, #16a34a)' }}>{m.texto}</span>}</td>
                        <td>
                          {m.id !== null && editandoAbono === m.id ? (
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                className="form-input"
                                style={{ width: '110px', padding: '4px 8px' }}
                                value={montoAbonoForm}
                                onChange={(e) => setMontoAbonoForm(e.target.value)}
                                autoFocus
                              />
                              <button className="btn btn-success btn-sm" onClick={() => guardarMontoAbono(m.id!)}>OK</button>
                              <button className="btn btn-ghost btn-sm" onClick={() => setEditandoAbono(null)}>✕</button>
                            </div>
                          ) : (
                            <>
                              {m.signo > 0 ? '' : '− '}${m.monto.toLocaleString('es-AR')}
                              {m.tieneComprobante && m.id && (
                                <button
                                  className="btn btn-ghost btn-sm"
                                  style={{ marginLeft: '6px' }}
                                  onClick={() => setComprobanteAbono({ id: m.id!, fecha: m.fecha, monto: m.monto })}
                                >
                                  Ver comprobante
                                </button>
                              )}
                              {m.id && (
                                <RoleGate roles={['admin', 'operador', 'finanzas']}>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    style={{ marginLeft: '6px' }}
                                    onClick={() => { setEditandoAbono(m.id); setMontoAbonoForm(String(m.monto)); }}
                                    title="Corregir el monto de este pago"
                                  >
                                    <Pencil size={11} strokeWidth={1.75} />
                                  </button>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => eliminarAbono(m.id!, m.monto)}
                                    title="Eliminar este pago"
                                  >
                                    <Trash2 size={11} strokeWidth={1.75} />
                                  </button>
                                </RoleGate>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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
                    <th>FECHA</th><th>DIRECCIÓN</th>
                    <th>TIPO BULTO</th><th>Nº CONTENEDOR</th><th>Nº REMITO</th>
                    <th>IMPORTE</th><th>TIPO DE PAGO</th><th>PAGADO</th><th>VENCIMIENTO</th>
                    <th>CHOFER</th><th>ESTADO</th>
                  </tr>
                </thead>
                <tbody>
                  {viajesDelMes.map((v) => {
                    const comprobantes = v.comprobantes ?? [];
                    // Una fila de extensión de retiro suelta (ver GET /:telefono/viajes
                    // en el backend) es su propio comprobante, no algo anidado bajo
                    // una entrega/recambio — ahí sí hay que tomar el alargue como
                    // "inicial" en vez de filtrarlo.
                    const inicial = v.tipo === 'alargue_retiro'
                      ? comprobantes.find((c) => c.tipo === 'alargue_retiro')
                      : comprobantes.find((c) => c.tipo !== 'alargue_retiro');
                    const esCC = v.es_cuenta_corriente || inicial?.es_cuenta_corriente;
                    return (
                    <tr key={v.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatearFecha(v.fecha)}</td>
                      <td>
                        {v.destino_direccion ? (
                          <>
                            <DireccionMaps direccion={v.destino_direccion} lat={v.destino_lat} lng={v.destino_lng} />
                            {v.zona && <div className="text-muted" style={{ fontSize: '11px' }}>{v.zona}</div>}
                          </>
                        ) : (v.zona ?? '—')}
                      </td>
                      <td>{tipoBulto(v)}</td>
                      <td className="mono">{v.contenedor_numero ?? '—'}</td>
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
                        ) : puedeEditarRemito && v.tipo !== 'alargue_retiro' ? (
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
                        {esCC ? (
                          <span className="badge pendiente">📋 Cuenta corriente</span>
                        ) : inicial?.medio_pago === 'efectivo' ? (
                          <span className="badge pendiente">💵 Efectivo</span>
                        ) : inicial ? (
                          <span className="badge pendiente">🏦 Transferencia</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td>
                        {esCC ? (
                          <span className="text-muted">—</span>
                        ) : inicial?.medio_pago === 'efectivo' ? (
                          puedeEditarRemito ? (
                            <button
                              className={`badge ${inicial.efectivo_cobrado ? 'disponible' : 'rechazado'}`}
                              style={{ border: 'none', cursor: 'pointer' }}
                              onClick={() => marcarCobrado(inicial.id, !inicial.efectivo_cobrado)}
                              title="Click para cambiar"
                            >
                              {inicial.efectivo_cobrado ? '✅ Pagado' : '❌ No pagado'}
                            </button>
                          ) : (
                            <span className={`badge ${inicial.efectivo_cobrado ? 'disponible' : 'rechazado'}`}>
                              {inicial.efectivo_cobrado ? '✅ Pagado' : '❌ No pagado'}
                            </span>
                          )
                        ) : inicial ? (
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                            <span className={`badge ${inicial.estado === 'validado' ? 'disponible' : inicial.estado === 'rechazado' ? 'rechazado' : 'pendiente'}`}>
                              {inicial.estado === 'validado' ? '✅ Pagado' : inicial.estado === 'rechazado' ? '❌ Rechazado' : '⏳ Pendiente'}
                            </span>
                            <button className="btn btn-ghost btn-sm" onClick={() => setViajeComprobantes(v)}>
                              Ver comprobante
                            </button>
                          </div>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{v.vence_en ? formatearFecha(v.vence_en) : <span className="text-muted">—</span>}</td>
                      <td>{v.chofer_nombre ?? '—'}</td>
                      <td><span className={`badge ${v.estado}`}>{v.estado}</span></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {viajeComprobantes && (() => {
        const comprobantesModal = viajeComprobantes.comprobantes ?? [];
        const inicial = viajeComprobantes.tipo === 'alargue_retiro'
          ? comprobantesModal.find((c) => c.tipo === 'alargue_retiro')
          : comprobantesModal.find((c) => c.tipo !== 'alargue_retiro');
        return (
          <div className="modal-overlay" onClick={() => setViajeComprobantes(null)}>
            <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div className="section-title" style={{ margin: 0 }}>Comprobante de pago</div>
                <button className="modal-close" onClick={() => setViajeComprobantes(null)}>
                  <X size={18} strokeWidth={2} />
                </button>
              </div>
              <p className="text-muted" style={{ marginTop: 0, marginBottom: 4 }}>
                {formatearFecha(viajeComprobantes.fecha)} · {tipoBulto(viajeComprobantes)}
                {viajeComprobantes.destino_direccion
                  ? ` · ${viajeComprobantes.destino_direccion}`
                  : viajeComprobantes.zona ? ` · ${viajeComprobantes.zona}` : ''}
              </p>
              {viajeComprobantes.importe && (
                <p className="text-muted" style={{ marginTop: 0 }}>
                  Importe: ${Number(viajeComprobantes.importe).toLocaleString('es-AR')}
                </p>
              )}
              {inicial?.titular && <p className="text-muted" style={{ margin: '0 0 6px' }}>Titular: {inicial.titular}</p>}
              {inicial?.tiene_comprobante ? (
                <ComprobanteViewer pagoId={inicial.id} />
              ) : (
                <p className="text-muted">Sin archivo de comprobante adjunto.</p>
              )}
              {inicial?.estado === 'validado' && (
                <RoleGate roles={['admin', 'operador', 'finanzas']}>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={() => reenviarAviso(inicial.id)}
                    disabled={reenviando === inicial.id}
                    title="Si el cliente dice que todavía no le llegó la confirmación por WhatsApp"
                  >
                    <Send size={12} strokeWidth={1.75} /> Reenviar aviso
                  </button>
                </RoleGate>
              )}
            </div>
          </div>
        );
      })()}

      {comprobanteAbono && (
        <div className="modal-overlay" onClick={() => setComprobanteAbono(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="section-title" style={{ margin: 0 }}>Comprobante de pago</div>
              <button className="modal-close" onClick={() => setComprobanteAbono(null)}>
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            <p className="text-muted" style={{ marginTop: 0, marginBottom: 4 }}>
              {formatearFecha(comprobanteAbono.fecha)} · Abono a cuenta corriente · ${comprobanteAbono.monto.toLocaleString('es-AR')}
            </p>
            <ComprobanteViewer pagoId={comprobanteAbono.id} />
          </div>
        </div>
      )}

      {mostrarCargarViaje && (
        <div className="modal-overlay" onClick={() => !guardandoViaje && setMostrarCargarViaje(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="section-title" style={{ margin: 0 }}>Cargar viaje finalizado</div>
              <button className="modal-close" onClick={() => setMostrarCargarViaje(false)}>
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            <p className="text-muted" style={{ marginTop: 0 }}>
              Para un viaje, recambio o extensión de retiro que ya pasó pero no quedó cargado en el sistema.
            </p>

            <div className="form-group">
              <label className="form-label">Tipo</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {([
                  ['entrega', 'Entrega'],
                  ['recambio', 'Recambio'],
                  ['alargue_retiro', 'Extensión de retiro'],
                ] as const).map(([valor, etiqueta]) => (
                  <button
                    key={valor}
                    type="button"
                    className={`btn btn-sm ${viajeForm.tipo === valor ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setViajeForm({ ...viajeForm, tipo: valor })}
                  >
                    {etiqueta}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '1 1 160px' }}>
                <label className="form-label">Fecha</label>
                <input
                  type="date"
                  className="form-input"
                  value={viajeForm.fecha}
                  onChange={(e) => setViajeForm({ ...viajeForm, fecha: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ flex: '1 1 160px' }}>
                <label className="form-label">Tarifa <span className="text-muted">(opcional)</span></label>
                <select
                  className="form-input"
                  value=""
                  onChange={(e) => { if (e.target.value) setViajeForm({ ...viajeForm, importe: e.target.value }); }}
                >
                  <option value="">Completar importe a mano...</option>
                  {tarifas.filter((t) => t.activo).map((t) => {
                    // Extensión de retiro cuesta PORCENTAJE_ALARGUE de la tarifa
                    // de la zona (ver bot.config.ts) — no el precio completo.
                    const precio = viajeForm.tipo === 'alargue_retiro'
                      ? Math.round(Number(t.precio) * PORCENTAJE_ALARGUE)
                      : Number(t.precio);
                    return (
                      <option key={t.departamento} value={precio}>
                        {t.departamento} — ${precio.toLocaleString('es-AR')}
                        {viajeForm.tipo === 'alargue_retiro' ? ` (${Math.round(PORCENTAJE_ALARGUE * 100)}% de $${Number(t.precio).toLocaleString('es-AR')})` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Importe</label>
              <input
                type="number" min="0" step="0.01"
                className="form-input"
                placeholder="$"
                value={viajeForm.importe}
                onChange={(e) => setViajeForm({ ...viajeForm, importe: e.target.value })}
              />
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '1 1 160px' }}>
                <label className="form-label">
                  {viajeForm.tipo === 'recambio' ? 'Contenedor retirado'
                    : viajeForm.tipo === 'alargue_retiro' ? <>Contenedor <span className="text-muted">(opcional)</span></>
                    : 'Contenedor'}
                </label>
                <input
                  className="form-input mono"
                  value={viajeForm.contenedor_numero}
                  onChange={(e) => setViajeForm({ ...viajeForm, contenedor_numero: e.target.value })}
                />
              </div>
              {viajeForm.tipo === 'recambio' && (
                <div className="form-group" style={{ flex: '1 1 160px' }}>
                  <label className="form-label">Contenedor entregado <span className="text-muted">(si se sabe)</span></label>
                  <input
                    className="form-input mono"
                    value={viajeForm.contenedor_numero_entrega}
                    onChange={(e) => setViajeForm({ ...viajeForm, contenedor_numero_entrega: e.target.value })}
                  />
                </div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">Medio de pago</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className={`btn btn-sm ${viajeForm.medio_pago === 'efectivo' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setViajeForm({ ...viajeForm, medio_pago: 'efectivo' })}
                >
                  Efectivo
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${viajeForm.medio_pago === 'transferencia' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setViajeForm({ ...viajeForm, medio_pago: 'transferencia' })}
                >
                  Transferencia
                </button>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">¿Ya está pagado?</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className={`btn btn-sm ${viajeForm.pagado ? 'btn-success' : 'btn-ghost'}`}
                  onClick={() => setViajeForm({ ...viajeForm, pagado: true })}
                >
                  Sí
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${!viajeForm.pagado ? 'btn-danger' : 'btn-ghost'}`}
                  onClick={() => setViajeForm({ ...viajeForm, pagado: false })}
                >
                  No
                </button>
              </div>
            </div>

            {viajeForm.pagado && viajeForm.medio_pago === 'transferencia' && (
              <div className="form-group">
                <label className="form-label">Comprobante de la transferencia</label>
                <input
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  onChange={(e) => setComprobanteFile(e.target.files?.[0] ?? null)}
                />
              </div>
            )}

            <p className="text-muted" style={{ fontSize: '0.8rem' }}>
              {viajeForm.pagado
                ? esCC
                  ? 'Ya está saldado: no se agrega a la cuenta corriente.'
                  : 'Ya está saldado, no hace falta nada más.'
                : esCC
                  ? 'Se agrega directo como cargo a su cuenta corriente. No se le manda nada por WhatsApp.'
                  : 'Se suma a sus montos pendientes y se le manda automáticamente la solicitud de pago por WhatsApp.'}
            </p>

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button className="btn btn-ghost" onClick={() => setMostrarCargarViaje(false)} disabled={guardandoViaje}>Cancelar</button>
              <button className="btn btn-success" onClick={cargarViajeManual} disabled={guardandoViaje}>
                {guardandoViaje ? 'Guardando...' : 'Cargar viaje'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
