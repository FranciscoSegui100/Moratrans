import { useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Send, Pencil, Check, X, Wallet, Receipt, CircleDollarSign, Plus, Trash2, Printer, MessageCircle } from 'lucide-react';
import { api, descargarArchivo } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { DireccionMaps } from '../components/DireccionMaps';
import { ComprobanteViewer } from '../components/ComprobanteViewer';
import { useAuth, tieneRol } from '../context/AuthContext';
import { formatearFecha } from '../lib/fechas';
import { hoyISO } from '../lib/viajes';
import { archivoABase64 } from '../lib/archivos';
import { useEscapeKey } from '../hooks/useEscapeKey';

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
  /** Estado para mostrar (ver GET /api/clientes/:telefono/viajes) — `estado` queda para la lógica. */
  estado_visible: EstadoVisible;
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
  tiene_foto_entrega?: boolean;
  comprobantes?: Comprobante[];
}

const ETIQUETA_CC: Record<Cliente['cuenta_corriente_estado'], { texto: string; clase: string }> = {
  sin_pedir: { texto: 'Ocasional', clase: 'retirado' },
  pendiente: { texto: 'Cuenta corriente (pendiente de aprobar)', clase: 'pendiente' },
  aprobada: { texto: 'Cuenta corriente', clase: 'disponible' },
  rechazada: { texto: 'Ocasional (cta. cte. rechazada)', clase: 'rechazado' },
};

/** Mismo criterio que excelClientes() en el backend — mantener en sync (texto para el Excel, no tocar). */
function tipoBulto(v: ViajeCliente): string {
  if (v.tipo === 'alargue_retiro') return 'Extensión de retiro';
  if (v.tipo === 'entrega') return 'VACIO';
  if (v.grupo_id) return 'Recambio';
  return 'Retiro';
}

type TipoPedido = 'entrega' | 'retiro' | 'recambio' | 'alargue_retiro';

/** Para distinguir visualmente los pedidos en pantalla (ver tipoBulto arriba para el texto que va al Excel, que no se toca). */
function tipoPedido(v: ViajeCliente): TipoPedido {
  if (v.tipo === 'alargue_retiro') return 'alargue_retiro';
  // Las dos patas de un recambio (retiro del lleno + entrega del vacío) comparten grupo_id.
  if (v.grupo_id) return 'recambio';
  return v.tipo as 'entrega' | 'retiro';
}

/** Cada fila es de un solo tipo — el backend ya manda cada alargue como su propia fila. */
function coincideFiltro(v: ViajeCliente, filtro: 'todos' | TipoPedido): boolean {
  return filtro === 'todos' || tipoPedido(v) === filtro;
}

const BADGE_PEDIDO: Record<TipoPedido, { texto: string; icono: string; clase: string }> = {
  entrega: { texto: 'Entrega', icono: '📦', clase: 'entrega' },
  retiro: { texto: 'Retiro', icono: '📥', clase: 'retiro' },
  recambio: { texto: 'Recambio', icono: '🔄', clase: 'recambio' },
  alargue_retiro: { texto: 'Alargue', icono: '⏳', clase: 'alargue' },
};

/**
 * El comprobante que representa el pago de ESTE pedido — no el de un alargue
 * nested de un pedido posterior con el mismo contenedor (ver GET
 * /:telefono/viajes en el backend). Si el pedido es en sí una extensión de
 * retiro cargada a mano (una fila de tipo 'retiro' que solo existe para
 * llevar el alargue, ver POST /api/contenedores/:numero/alargue), no hay
 * ningún comprobante "propio" que priorizar por encima del de alargue — sin
 * este fallback esa fila mostraba "Tipo de pago"/"Pagado" en blanco aunque
 * la plata sí sumaba a la deuda del cliente.
 */
function elegirInicial(tipo: ViajeCliente['tipo'], comprobantes: Comprobante[]): Comprobante | undefined {
  if (tipo === 'alargue_retiro') return comprobantes.find((c) => c.tipo === 'alargue_retiro');
  return comprobantes.find((c) => c.tipo !== 'alargue_retiro') ?? comprobantes.find((c) => c.tipo === 'alargue_retiro');
}

function etiquetaMes(mes: string): string {
  const [anio, m] = mes.split('-');
  const texto = new Date(Number(anio), Number(m) - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Mismo valor que PORCENTAJE_ALARGUE en backend/src/config/bot.config.ts — mantener en sync. */
const PORCENTAJE_ALARGUE = 0.5;

// "Cargar viaje finalizado" queda armado (backend + modal) pero oculto a
// pedido del dueño del negocio — todavía no lo quiere activo en el panel.
// El endpoint sigue existiendo; para reactivar la función alcanza con
// volver esto a `true`.
const CARGAR_VIAJE_HABILITADO = false;

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
    fecha: hoyISO(),
    contenedor_numero: '',
    contenedor_numero_entrega: '',
    importe: '',
    medio_pago: 'transferencia',
    pagado: true,
  };
}


type EstadoVisible =
  | 'pendiente' | 'en_curso' | 'entregado' | 'retirado' | 'vaciado' | 'cancelado'
  | 'aplicada' | 'pendiente_pago' | 'rechazada';

/** Texto y color (clase de .badge) de la columna ESTADO. */
const ESTADO_VISIBLE: Record<EstadoVisible, { texto: string; badge: string }> = {
  pendiente: { texto: 'Pendiente', badge: 'programado' },
  en_curso: { texto: 'En curso', badge: 'en_curso' },
  entregado: { texto: 'Entregado', badge: 'completado' },
  retirado: { texto: 'Retirado (sin vaciar)', badge: 'retirado' },
  vaciado: { texto: 'Retirado y vaciado', badge: 'completado' },
  cancelado: { texto: 'Cancelado', badge: 'cancelado' },
  aplicada: { texto: 'Aplicada', badge: 'completado' },
  pendiente_pago: { texto: 'Pendiente de pago', badge: 'pendiente' },
  rechazada: { texto: 'Pago rechazado', badge: 'rechazado' },
};

export function ClienteDetalle() {
  const { telefono = '' } = useParams<{ telefono: string }>();
  const navigate = useNavigate();
  const { show } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const puedeEditarRemito = tieneRol(user, 'admin', 'operador', 'finanzas');
  const puedeEditarZona = tieneRol(user, 'admin', 'operador');
  const [enviando, setEnviando] = useState(false);
  const [editandoRemito, setEditandoRemito] = useState<string | null>(null);
  // Corregir el contenedor de una entrega ya hecha (el chofer eligió mal al
  // tocar "Ya entregué") — mismo POST que el "Cambiar" de Viajes.
  const puedeCambiarContenedor = tieneRol(user, 'admin', 'operador');
  const [cambiandoContenedor, setCambiandoContenedor] = useState<string | null>(null);
  const [contenedorNuevo, setContenedorNuevo] = useState('');
  const [remitoForm, setRemitoForm] = useState('');
  const [editandoZona, setEditandoZona] = useState<ViajeCliente | null>(null);
  const [zonaForm, setZonaForm] = useState('');
  const [guardandoZona, setGuardandoZona] = useState(false);
  const [viajeComprobantes, setViajeComprobantes] = useState<ViajeCliente | null>(null);
  const [viajeFotoEntrega, setViajeFotoEntrega] = useState<ViajeCliente | null>(null);
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

  useEscapeKey(() => setViajeComprobantes(null), viajeComprobantes !== null);
  useEscapeKey(() => setViajeFotoEntrega(null), viajeFotoEntrega !== null);
  useEscapeKey(() => !guardandoZona && setEditandoZona(null), editandoZona !== null);
  useEscapeKey(() => setComprobanteAbono(null), comprobanteAbono !== null);
  useEscapeKey(() => !guardandoViaje && setMostrarCargarViaje(false), mostrarCargarViaje);

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

  async function cambiarContenedor(viajeId: string) {
    if (!contenedorNuevo) return;
    try {
      const { data } = await api.post<{ anterior: string; nuevo: string }>(`/api/viajes/${viajeId}/cambiar-contenedor`, {
        contenedor_numero: contenedorNuevo,
      });
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'viajes'] });
      queryClient.invalidateQueries({ queryKey: ['contenedores'] });
      setCambiandoContenedor(null);
      setContenedorNuevo('');
      show('success', 'Contenedor corregido', `${data.anterior} → ${data.nuevo}`);
    } catch (err: any) {
      show('error', 'No se pudo corregir', err.response?.data?.error);
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

  /**
   * Corrige el departamento de un pedido ya confirmado (ej. el cliente se
   * equivocó al pedirlo) — a propósito NO toca el importe ya pagado (ver
   * comentario de `cambiaZona` en el backend): si el precio del departamento
   * nuevo es distinto, se avisa para que alguien lo resuelva a mano, nada
   * automático con la plata.
   */
  async function guardarZona() {
    if (!editandoZona || !zonaForm) return;
    setGuardandoZona(true);
    try {
      const { data } = await api.patch(`/api/viajes/${editandoZona.id}`, { zona: zonaForm });
      queryClient.invalidateQueries({ queryKey: ['clientes', telefono, 'viajes'] });
      const pagado = editandoZona.importe != null ? Number(editandoZona.importe) : null;
      const tarifaNueva = data.tarifaZonaNueva != null ? Number(data.tarifaZonaNueva) : null;
      if (pagado != null && tarifaNueva != null && pagado !== tarifaNueva) {
        show(
          'info',
          'Departamento actualizado — revisar diferencia de precio',
          `Se pagó $${pagado.toLocaleString('es-AR')} pero la tarifa de ${zonaForm} es $${tarifaNueva.toLocaleString('es-AR')}. La diferencia no se ajustó sola, coordinala con el cliente.`,
        );
      } else {
        show('success', 'Departamento actualizado');
      }
      setEditandoZona(null);
    } catch (err: any) {
      show('error', 'No se pudo cambiar el departamento', err.response?.data?.error);
    } finally {
      setGuardandoZona(false);
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

  // Mismo query key que Contenedores.tsx: si ya se visitó, sale de caché.
  const { data: contenedores = [] } = useQuery({
    queryKey: ['contenedores'],
    queryFn: () => api.get<{ numero: string; estado: string; tamano: number | null }[]>('/api/contenedores').then((r) => r.data),
    enabled: puedeCambiarContenedor,
  });
  const disponiblesParaCambio = contenedores.filter((c) => c.estado === 'disponible');

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

  // Con muchos pedidos mezclados cuesta distinguir qué es cada fila — filtro
  // rápido por tipo antes de agrupar por mes.
  const [filtroPedido, setFiltroPedido] = useState<'todos' | TipoPedido>('todos');
  const conteosPedido = useMemo(() => {
    const c: Record<TipoPedido, number> = { entrega: 0, retiro: 0, recambio: 0, alargue_retiro: 0 };
    for (const t of Object.keys(c) as TipoPedido[]) c[t] = viajes.filter((v) => coincideFiltro(v, t)).length;
    return c;
  }, [viajes]);
  const viajesFiltrados = viajes.filter((v) => coincideFiltro(v, filtroPedido));

  // Ya vienen ordenados por fecha DESC desde el backend: agrupar preservando
  // ese orden deja los meses más recientes arriba sin tener que reordenar.
  const grupos = useMemo(() => {
    const porMes = new Map<string, ViajeCliente[]>();
    for (const v of viajesFiltrados) {
      const mes = v.fecha.slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, []);
      porMes.get(mes)!.push(v);
    }
    return [...porMes.entries()];
  }, [viajesFiltrados]);

  const cc = cliente ? ETIQUETA_CC[cliente.cuenta_corriente_estado] : null;

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <Link to="/clientes" className="btn btn-ghost btn-sm" style={{ margin: 0 }}>
            <ArrowLeft size={14} strokeWidth={1.75} /> Volver a Clientes
          </Link>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Link to={`/conversaciones?tel=${encodeURIComponent(telefono)}`} className="btn btn-primary btn-sm">
              <MessageCircle size={13} strokeWidth={1.75} /> Ir a la conversación
            </Link>
            <RoleGate roles={['admin', 'operador', 'finanzas']}>
              <button className="btn btn-danger btn-sm" onClick={eliminarCliente} title="Eliminar cliente">
                <Trash2 size={13} strokeWidth={1.75} /> Eliminar cliente
              </button>
            </RoleGate>
          </div>
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
        <button
          className="btn btn-ghost"
          onClick={() => {
            const win = window.open('', '_blank');
            if (!win) return;

            // 1. Movimientos de cuenta corriente
            const movsCC = [
              ...(cuentaCorriente?.cargos ?? []).map((c) => ({
                fecha: c.fecha,
                concepto: `Servicio flete (${c.zona ?? 'Sin zona'})`,
                debe: Number(c.monto || 0),
                haber: 0,
              })),
              ...(cuentaCorriente?.abonos ?? []).map((a) => ({
                fecha: a.fecha,
                concepto: 'Pago recibido / Acreditado',
                debe: 0,
                haber: Number(a.monto || 0),
              })),
            ];

            // 2. Pedidos y viajes fuera de cuenta corriente (efectivo, transferencia, ocasionales)
            const movsViajes: { fecha: string; concepto: string; debe: number; haber: number }[] = [];
            for (const v of viajes) {
              if (v.estado_visible === 'cancelado') continue;
              if (v.tipo === 'retiro' && v.grupo_id != null) continue; // Pata retiro de recambio no duplica importe

              const comprobantes = v.comprobantes ?? [];
              const inicial = elegirInicial(v.tipo, comprobantes);
              if (v.es_cuenta_corriente || inicial?.es_cuenta_corriente) continue;

              const monto = Number(v.importe ?? inicial?.monto ?? 0);
              if (monto <= 0) continue;

              let concepto = tipoBulto(v);
              if (v.zona) concepto += ` (${v.zona})`;
              if (v.contenedor_numero) concepto += ` · Cont. ${v.contenedor_numero}`;

              let haber = 0;
              if (inicial?.medio_pago === 'efectivo') {
                if (inicial.efectivo_cobrado) haber = monto;
              } else if (inicial?.medio_pago === 'transferencia') {
                if (inicial.estado === 'validado') haber = monto;
              }

              movsViajes.push({
                fecha: v.fecha,
                concepto,
                debe: monto,
                haber,
              });
            }

            const movimientos = [...movsCC, ...movsViajes].sort((a, b) => a.fecha.localeCompare(b.fecha));

            const totalCargos = movimientos.reduce((s, m) => s + m.debe, 0);
            const totalPagado = movimientos.reduce((s, m) => s + m.haber, 0);
            const saldoPendiente = totalCargos - totalPagado;

            let saldoAcumulado = 0;
            const filasHtml = movimientos.map((m) => {
              saldoAcumulado += (m.debe - m.haber);
              return `
                <tr>
                  <td style="padding: 8px; border: 1px solid #ddd;">${m.fecha.slice(0, 10)}</td>
                  <td style="padding: 8px; border: 1px solid #ddd;">${m.concepto}</td>
                  <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${m.debe > 0 ? '$' + m.debe.toLocaleString('es-AR') : '—'}</td>
                  <td style="padding: 8px; border: 1px solid #ddd; text-align: right; color: green;">${m.haber > 0 ? '$' + m.haber.toLocaleString('es-AR') : '—'}</td>
                  <td style="padding: 8px; border: 1px solid #ddd; text-align: right; font-weight: bold; color: ${saldoAcumulado > 0 ? '#b91c1c' : '#15803d'};">$${saldoAcumulado.toLocaleString('es-AR')}</td>
                </tr>
              `;
            }).join('');

            win.document.write(`
              <html>
                <head>
                  <title>Estado de Cuenta - ${cliente?.nombre ?? telefono}</title>
                  <style>
                    body { font-family: system-ui, sans-serif; margin: 30px; color: #111; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 0.9rem; }
                    th { background: #f2f2f2; padding: 10px; border: 1px solid #ddd; text-align: left; }
                    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #222; padding-bottom: 12px; }
                    .kpis { display: flex; gap: 20px; margin-top: 20px; background: #f9f9f9; padding: 15px; border-radius: 6px; }
                    .kpi { flex: 1; }
                    .kpi-val { font-size: 1.25rem; font-weight: bold; margin-top: 4px; }
                  </style>
                </head>
                <body>
                  <div class="header">
                    <div>
                      <h2 style="margin: 0;">MORATRANS - ESTADO DE CUENTA${esCC ? ' CORRIENTE' : ''}</h2>
                      <p style="margin: 4px 0 0; color: #666;">Alquiler y Traslado de Contenedores</p>
                    </div>
                    <div style="text-align: right;">
                      <h3 style="margin: 0;">${cliente?.nombre ?? 'Cliente'}</h3>
                      <p style="margin: 4px 0 0; color: #666;">Tel: ${telefono}</p>
                      <p style="margin: 2px 0 0; color: #666;">Fecha emisión: ${new Date().toLocaleDateString('es-AR')}</p>
                    </div>
                  </div>

                  <div class="kpis">
                    <div class="kpi">
                      <div style="color: #666; font-size: 0.85rem;">Total Cargos</div>
                      <div class="kpi-val">$${totalCargos.toLocaleString('es-AR')}</div>
                    </div>
                    <div class="kpi">
                      <div style="color: #666; font-size: 0.85rem;">Total Pagado</div>
                      <div class="kpi-val" style="color: green;">$${totalPagado.toLocaleString('es-AR')}</div>
                    </div>
                    <div class="kpi">
                      <div style="color: #666; font-size: 0.85rem;">Saldo Pendiente</div>
                      <div class="kpi-val" style="color: ${saldoPendiente > 0 ? '#b91c1c' : '#15803d'};">
                        $${saldoPendiente.toLocaleString('es-AR')}
                      </div>
                    </div>
                  </div>

                  <table>
                    <thead>
                      <tr>
                        <th>FECHA</th>
                        <th>CONCEPTO</th>
                        <th style="text-align: right;">CARGO (DEBE)</th>
                        <th style="text-align: right;">PAGO (HABER)</th>
                        <th style="text-align: right;">SALDO</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${filasHtml || '<tr><td colspan="5" style="text-align: center; padding: 20px;">Sin movimientos registrados</td></tr>'}
                    </tbody>
                  </table>
                </body>
              </html>
            `);
            win.document.close();
            win.focus();
            win.print();
          }}
        >
          <Printer strokeWidth={1.75} /> Imprimir Estado de Cuenta
        </button>
        <small className="text-muted">Exportá o imprimí el estado consolidado de cuenta para el cliente.</small>
        {CARGAR_VIAJE_HABILITADO && (
          <RoleGate roles={['admin', 'operador', 'finanzas']}>
            <button className="btn btn-ghost" onClick={() => setMostrarCargarViaje(true)}>
              <Plus strokeWidth={1.75} /> Cargar viaje finalizado
            </button>
          </RoleGate>
        )}
        <RoleGate roles={['admin', 'operador', 'finanzas']}>
          <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={enviarResumenPorWhatsApp} disabled={enviando}>
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

      {viajes.length > 0 && (
        <div className="btn-group" style={{ marginTop: '20px', flexWrap: 'wrap' }}>
          <button className={`btn btn-sm ${filtroPedido === 'todos' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFiltroPedido('todos')}>
            Todos ({viajes.length})
          </button>
          {(Object.keys(BADGE_PEDIDO) as TipoPedido[]).map((t) => (
            <button
              key={t}
              className={`btn btn-sm ${filtroPedido === t ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFiltroPedido(t)}
              disabled={conteosPedido[t] === 0}
            >
              {BADGE_PEDIDO[t].icono} {BADGE_PEDIDO[t].texto}s ({conteosPedido[t]})
            </button>
          ))}
        </div>
      )}

      {grupos.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-title">
              {viajes.length === 0 ? 'Sin viajes registrados' : 'Ningún pedido de este tipo'}
            </div>
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
                    <th>TIPO</th><th>Nº CONTENEDOR</th><th>Nº REMITO</th>
                    <th>IMPORTE</th><th>TIPO DE PAGO</th><th>PAGADO</th><th>VENCIMIENTO</th>
                    <th>CHOFER</th><th>ESTADO</th>
                  </tr>
                </thead>
                <tbody>
                  {viajesDelMes.map((v) => {
                    const comprobantes = v.comprobantes ?? [];
                    const inicial = elegirInicial(v.tipo, comprobantes);
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
                        {puedeEditarZona && v.tipo !== 'alargue_retiro' && v.estado !== 'completado' && v.estado !== 'cancelado' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ marginTop: '2px', padding: '1px 6px' }}
                            onClick={() => { setEditandoZona(v); setZonaForm(v.zona ?? ''); }}
                            title="Corregir el departamento (ej. el cliente se equivocó al pedirlo)"
                          >
                            Cambiar depto. <Pencil size={10} strokeWidth={1.75} />
                          </button>
                        )}
                      </td>
                      <td>
                        {(() => {
                          const b = BADGE_PEDIDO[tipoPedido(v)];
                          return (
                            <span className={`tag ${b.clase}`} title={tipoBulto(v)}>
                              {b.icono} {b.texto}
                              {v.grupo_id && <span style={{ fontWeight: 400 }}>· {v.tipo === 'retiro' ? 'retira' : 'deja'}</span>}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="mono">
                        {cambiandoContenedor === v.id ? (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <select
                              className="form-select"
                              style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                              value={contenedorNuevo}
                              onChange={(e) => setContenedorNuevo(e.target.value)}
                            >
                              <option value="">— Correcto —</option>
                              {disponiblesParaCambio.map((c) => (
                                <option key={c.numero} value={c.numero}>{c.tamano ? `${c.numero} (${c.tamano} m³)` : c.numero}</option>
                              ))}
                            </select>
                            <button className="btn btn-success btn-sm" onClick={() => cambiarContenedor(v.id)}>OK</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setCambiandoContenedor(null)}>✕</button>
                          </div>
                        ) : v.contenedor_numero ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            {v.contenedor_numero}
                            {/* Entrega ya hecha y con el ciclo abierto: se puede corregir si el chofer eligió mal. */}
                            {puedeCambiarContenedor && v.tipo === 'entrega' && v.estado_visible === 'entregado' && v.estado !== 'completado' && (
                              <button
                                className="btn btn-ghost btn-sm"
                                title="El chofer eligió mal: cambiar por el contenedor que dejó de verdad"
                                onClick={() => { setCambiandoContenedor(v.id); setContenedorNuevo(''); }}
                              >
                                Cambiar <Pencil size={11} strokeWidth={1.75} />
                              </button>
                            )}
                          </span>
                        ) : v.tipo === 'entrega' && v.estado_visible !== 'cancelado' ? (
                          // El contenedor de una entrega lo elige el chofer al tocar "Ya entregué".
                          <span className="text-muted" style={{ fontFamily: 'inherit' }}>Lo elige el chofer</span>
                        ) : '—'}
                      </td>
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
                      <td>
                        {(() => {
                          // Fallback a inicial?.monto: filas de alargue cargadas antes de
                          // este fix tienen el pago linkeado pero el importe propio en
                          // blanco (ver POST /api/contenedores/:numero/alargue).
                          const monto = v.importe ?? inicial?.monto;
                          return monto ? `$${Number(monto).toLocaleString('es-AR')}` : <span className="text-muted">—</span>;
                        })()}
                      </td>
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
                        {esCC || v.estado_visible === 'cancelado' ? (
                          // Cancelado: no se le debe nada por este viaje (no suma a la deuda).
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
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          {(() => {
                            const e = ESTADO_VISIBLE[v.estado_visible] ?? { texto: v.estado, badge: v.estado };
                            return <span className={`badge ${e.badge}`}>{e.texto}</span>;
                          })()}
                          {v.tiene_foto_entrega && (
                            <RoleGate roles={['admin', 'operador', 'finanzas']}>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => setViajeFotoEntrega(v)}
                                title="Ver foto del contenedor entregado en la locación"
                              >
                                📸 Ver foto
                              </button>
                            </RoleGate>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {viajeFotoEntrega && (
        <div className="modal-overlay" onClick={() => setViajeFotoEntrega(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="section-title" style={{ margin: 0 }}>
                📸 Foto de entrega{viajeFotoEntrega.contenedor_numero ? ` · Contenedor ${viajeFotoEntrega.contenedor_numero}` : ''}
              </div>
              <button className="modal-close" onClick={() => setViajeFotoEntrega(null)}>
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            <p className="text-muted" style={{ marginTop: 0, marginBottom: 8 }}>
              {formatearFecha(viajeFotoEntrega.fecha)} · {tipoBulto(viajeFotoEntrega)}
              {viajeFotoEntrega.destino_direccion
                ? ` · ${viajeFotoEntrega.destino_direccion}`
                : viajeFotoEntrega.zona ? ` · ${viajeFotoEntrega.zona}` : ''}
              {viajeFotoEntrega.chofer_nombre ? ` · Chofer: ${viajeFotoEntrega.chofer_nombre}` : ''}
            </p>
            <ComprobanteViewer viajeFotoId={viajeFotoEntrega.id} />
          </div>
        </div>
      )}

      {viajeComprobantes && (() => {
        const comprobantesModal = viajeComprobantes.comprobantes ?? [];
        const inicial = elegirInicial(viajeComprobantes.tipo, comprobantesModal);
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

      {editandoZona && (() => {
        const pagado = editandoZona.importe != null ? Number(editandoZona.importe) : null;
        const tarifaElegida = tarifas.find((t) => t.departamento === zonaForm && t.activo);
        const precioNuevo = tarifaElegida ? Number(tarifaElegida.precio) : null;
        const difiere = pagado != null && precioNuevo != null && pagado !== precioNuevo;
        return (
          <div className="modal-overlay" onClick={() => !guardandoZona && setEditandoZona(null)}>
            <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div className="section-title" style={{ margin: 0 }}>Cambiar departamento</div>
                <button className="modal-close" onClick={() => setEditandoZona(null)}>
                  <X size={18} strokeWidth={2} />
                </button>
              </div>
              <p className="text-muted" style={{ marginTop: 0 }}>
                {formatearFecha(editandoZona.fecha)} · {editandoZona.destino_direccion ?? editandoZona.zona ?? 'Sin dirección'}
                {editandoZona.zona && <> — departamento actual: <b>{editandoZona.zona}</b></>}
              </p>
              <div className="form-group">
                <label className="form-label">Departamento correcto</label>
                <select className="form-input" value={zonaForm} onChange={(e) => setZonaForm(e.target.value)}>
                  <option value="">Elegir...</option>
                  {tarifas.filter((t) => t.activo).map((t) => (
                    <option key={t.departamento} value={t.departamento}>{t.departamento} — ${Number(t.precio).toLocaleString('es-AR')}</option>
                  ))}
                </select>
              </div>
              {difiere && (
                <div className="rc-warn" style={{ marginTop: '10px', background: 'var(--warning-bg)', padding: '8px 12px', borderRadius: 'var(--radius)' }}>
                  ⚠️ Se pagó ${pagado!.toLocaleString('es-AR')} pero {zonaForm} tiene tarifa ${precioNuevo!.toLocaleString('es-AR')}.
                  No se ajusta el importe solo — coordiná la diferencia con el cliente aparte.
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
                <button className="btn btn-ghost" onClick={() => setEditandoZona(null)} disabled={guardandoZona}>Cancelar</button>
                <button className="btn btn-primary" onClick={guardarZona} disabled={guardandoZona || !zonaForm || zonaForm === editandoZona.zona}>
                  {guardandoZona ? 'Guardando...' : 'Confirmar cambio'}
                </button>
              </div>
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
