import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowUp, ArrowDown, Plus, X, RefreshCw, CheckCircle2, GripVertical } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { DireccionMaps } from '../components/DireccionMaps';
import { PedidoDetalleModal } from '../components/PedidoDetalleModal';
import { formatearFecha } from '../lib/fechas';

interface Ruta {
  id: string;
  fecha: string;
  chofer_id: string;
  chofer_nombre: string | null;
  patente: string | null;
  estado: 'planificada' | 'en_curso' | 'finalizada' | 'cancelada';
  notas: string | null;
  version: number;
  creado_en: string;
}
interface Chofer { id: string; nombre: string; activo: boolean; }
interface Ubicacion { id: string; tipo: 'deposito' | 'vaciadero'; nombre: string; activo: boolean; }

interface ViajePendiente {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  zona: string | null;
  contenedor_numero: string | null;
  destino_direccion: string | null;
  destino_lat: string | null;
  destino_lng: string | null;
  horario_preferido: string | null;
  hora_estimada: string | null;
  cliente_telefono: string | null;
  chofer_id?: string | null;
  ruta_id?: string | null;
  orden?: number | null;
  grupo_id: string | null;
  planificable?: boolean;
  // Datos extra para el detalle del pedido (GET /api/rutas/bolsa).
  cliente_nombre?: string | null;
  notas?: string | null;
  remito?: string | null;
  importe?: string | null;
  es_cuenta_corriente?: boolean;
  ubicacion_direccion?: string | null;
  direccion_verificada?: boolean;
  creado_en?: string;
}
/** Un recambio son dos filas (retiro+entrega) que comparten grupo_id — se muestran como una sola visita. */
interface VisitaPendiente {
  id: string;
  fecha: string;
  zona: string | null;
  destino_direccion: string | null;
  destino_lat: string | null;
  destino_lng: string | null;
  horario_preferido: string | null;
  cliente_telefono: string | null;
  chofer_id: string | null;
  entrega?: ViajePendiente;
  retiro?: ViajePendiente;
}
function agruparPendientes(viajes: ViajePendiente[]): VisitaPendiente[] {
  const porGrupo = new Map<string, VisitaPendiente>();
  const sueltas: VisitaPendiente[] = [];
  for (const v of viajes) {
    if (!v.grupo_id) {
      const visita: VisitaPendiente = {
        id: v.id,
        fecha: v.fecha,
        zona: v.zona,
        destino_direccion: v.destino_direccion,
        destino_lat: v.destino_lat,
        destino_lng: v.destino_lng,
        horario_preferido: v.horario_preferido,
        cliente_telefono: v.cliente_telefono,
        chofer_id: v.chofer_id ?? null,
      };
      if (v.tipo === 'entrega') visita.entrega = v;
      if (v.tipo === 'retiro') visita.retiro = v;
      sueltas.push(visita);
      continue;
    }
    let visita = porGrupo.get(v.grupo_id);
    if (!visita) {
      visita = {
        id: v.grupo_id,
        fecha: v.fecha,
        zona: v.zona,
        destino_direccion: v.destino_direccion,
        destino_lat: v.destino_lat,
        destino_lng: v.destino_lng,
        horario_preferido: v.horario_preferido,
        cliente_telefono: v.cliente_telefono,
        chofer_id: v.chofer_id ?? null,
      };
      porGrupo.set(v.grupo_id, visita);
    }
    if (!visita.destino_direccion && v.destino_direccion) {
      visita.destino_direccion = v.destino_direccion;
      visita.destino_lat = v.destino_lat;
      visita.destino_lng = v.destino_lng;
    }
    if (!visita.horario_preferido && v.horario_preferido) visita.horario_preferido = v.horario_preferido;
    if (!visita.zona && v.zona) visita.zona = v.zona;
    if (v.tipo === 'entrega') visita.entrega = v;
    if (v.tipo === 'retiro') visita.retiro = v;
  }
  return [...sueltas, ...porGrupo.values()];
}

interface StatsRuta { paradas: number; ent: number; ret: number; rec: number; warn: number; }
/** Resumen por ruta para las tarjetas — cuenta visitas (recambio = 1 sola) agrupando por `orden`. No incluye vaciados (viven en otra tabla), solo da una idea rápida antes de abrir el detalle. */
function statsPorRuta(viajesDia: ViajePendiente[]): Map<string, StatsRuta> {
  const porRuta = new Map<string, ViajePendiente[]>();
  for (const v of viajesDia) {
    if (!v.ruta_id) continue;
    const lista = porRuta.get(v.ruta_id) ?? [];
    lista.push(v);
    porRuta.set(v.ruta_id, lista);
  }
  const resultado = new Map<string, StatsRuta>();
  porRuta.forEach((viajes, rutaId) => {
    const porOrden = new Map<number, ViajePendiente[]>();
    for (const v of viajes) {
      const key = v.orden ?? 0;
      const lista = porOrden.get(key) ?? [];
      lista.push(v);
      porOrden.set(key, lista);
    }
    let ent = 0, ret = 0, rec = 0, warn = 0;
    porOrden.forEach((visita) => {
      const entrega = visita.find((v) => v.tipo === 'entrega');
      const retiro = visita.find((v) => v.tipo === 'retiro');
      if (entrega && retiro) { rec++; if (!entrega.contenedor_numero) warn++; }
      else if (entrega) { ent++; if (!entrega.contenedor_numero) warn++; }
      else if (retiro) { ret++; }
    });
    resultado.set(rutaId, { paradas: ent + ret + rec, ent, ret, rec, warn });
  });
  return resultado;
}

const ETIQUETA_ESTADO: Record<Ruta['estado'], { texto: string; clase: string }> = {
  planificada: { texto: 'Planificada', clase: 'programado' },
  en_curso: { texto: 'En curso', clase: 'en_curso' },
  finalizada: { texto: 'Finalizada', clase: 'completado' },
  cancelada: { texto: 'Cancelada', clase: 'cancelado' },
};

const iniciales = (nombre: string) => nombre.split(',')[0].slice(0, 2).toUpperCase();

// Umbral a partir del cual un pedido sin rutear se marca en color de alerta
// (mismo lenguaje visual que "parada sin contenedor válido"): mismo riesgo
// que el vencimiento de contenedores que no se revisa a tiempo, aplicado acá.
const DIAS_ALERTA_COLA = 1;

function diasEspera(fecha: string): number {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const [anio, mes, dia] = fecha.slice(0, 10).split('-').map(Number);
  const fechaPedido = new Date(anio, mes - 1, dia);
  return Math.round((hoy.getTime() - fechaPedido.getTime()) / 86_400_000);
}

function etiquetaEspera(dias: number, fecha: string): string {
  if (dias === 0) return 'hoy';
  if (dias === -1) return 'para mañana';
  if (dias < -1) {
    const [, mes, dia] = fecha.slice(0, 10).split('-');
    return `para el ${dia}/${mes}`;
  }
  if (dias === 1) return 'hace 1 día';
  return `hace ${dias} días`;
}

/** 'atrasado' incluye dias === 1 ("hace 1 día"): todavía no es 2+, pero tampoco es hoy. */
type CategoriaDia = 'atrasado' | 'hoy' | 'proximo';

function categoriaDia(dias: number): CategoriaDia {
  if (dias > 0) return 'atrasado';
  return dias === 0 ? 'hoy' : 'proximo';
}

/** Título de la sección de un día puntual de la bolsa (una sección por fecha, no por balde). */
function tituloSeccionDia(fecha: string): string {
  const dias = diasEspera(fecha);
  if (dias === 0) return 'Hoy';
  const etiqueta = etiquetaEspera(dias, fecha);
  return dias > 0 ? `Atrasado — ${etiqueta}` : `Próximo — ${etiqueta}`;
}

// ── Detalle de una ruta (paradas, confirmación, vaciados) ─────────────────────

interface ParadaViaje {
  tipo_parada: 'viaje';
  id: string;
  orden: number;
  viaje_tipo: 'entrega' | 'retiro';
  contenedor_numero: string | null;
  destino_direccion: string | null;
  destino_lat: string | null;
  destino_lng: string | null;
  horario_preferido: string | null;
  hora_estimada: string | null;
  zona: string | null;
  cliente_telefono: string | null;
  grupo_id: string | null;
  estado: string;
  notas: string | null;
  disponibles?: string[];
}
interface ParadaVaciado {
  tipo_parada: 'vaciado';
  id: string;
  orden: number;
  ubicacion_id: string | null;
  ubicacion_nombre: string | null;
  notas: string | null;
}
type Parada = ParadaViaje | ParadaVaciado;

interface Advertencia { orden: number; tipo: 'lleno_sin_vaciar' | 'vacios_exceso'; mensaje: string; }

interface RutaData extends Ruta {
  paradas: Parada[];
  advertencias: Advertencia[];
  /** Stock que el backend usa como punto de partida de la simulación: contenedores
   * 'disponible' NO comprometidos con ningún viaje activo ajeno a esta ruta.
   * Es la misma lista contra la que se validan los selects de cada parada. */
  stock_deposito: string[];
}

/** Agrupa las paradas (ya ordenadas por el backend) en "visitas": un recambio son dos filas de `viajes` que comparten `orden` y se muestran como una sola. */
interface Visita {
  orden: number;
  id: string;
  tipoParada: 'viaje' | 'vaciado';
  entrega?: ParadaViaje;
  retiro?: ParadaViaje;
  vaciado?: ParadaVaciado;
}
function agruparVisitas(paradas: Parada[]): Visita[] {
  const porOrden = new Map<number, Visita>();
  for (const p of paradas) {
    let v = porOrden.get(p.orden);
    if (!v) { v = { orden: p.orden, id: p.id, tipoParada: p.tipo_parada }; porOrden.set(p.orden, v); }
    if (p.tipo_parada === 'vaciado') { v.vaciado = p; v.id = p.id; v.tipoParada = 'vaciado'; }
    else if (p.viaje_tipo === 'entrega') { v.entrega = p; v.id = p.id; v.tipoParada = 'viaje'; }
    else { v.retiro = p; if (!v.entrega) v.id = p.id; v.tipoParada = 'viaje'; }
  }
  return [...porOrden.values()].sort((a, b) => a.orden - b.orden);
}

function DetalleRuta({ rutaId, rutasDelDia, choferes, onCambio }: {
  rutaId: string;
  rutasDelDia: Ruta[];
  choferes: Chofer[];
  onCambio: () => void;
}) {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [agregandoVaciado, setAgregandoVaciado] = useState(false);
  const [vaciadoForm, setVaciadoForm] = useState({ ubicacion_id: '', notas: '' });
  const [confirmando, setConfirmando] = useState(false);
  const [reordenando, setReordenando] = useState(false);
  // Reordenar paradas con drag & drop: `dragIdx` es la parada que se arrastra,
  // `overIdx` sobre cuál está parada ahora (para el resaltado).
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const { data: ruta } = useQuery({
    queryKey: ['rutas', rutaId],
    queryFn: () => api.get<RutaData>(`/api/rutas/${rutaId}`).then((r) => r.data),
    // Refresca los disponibles por parada (simulación del backend) cada 15 s
    // para que los selects de contenedor muestren siempre el stock real.
    refetchInterval: 15000,
  });
  const { data: ubicaciones = [] } = useQuery({
    queryKey: ['ubicaciones'],
    queryFn: () => api.get<Ubicacion[]>('/api/ubicaciones').then((r) => r.data.filter((u) => u.activo)),
  });
  const vaciaderos = ubicaciones.filter((u) => u.tipo === 'vaciadero');

  const cargar = () => {
    queryClient.invalidateQueries({ queryKey: ['rutas', rutaId] });
    onCambio();
  };

  const visitas = ruta ? agruparVisitas(ruta.paradas) : [];
  const editable = ruta?.estado === 'planificada' || ruta?.estado === 'en_curso';

  // Stock real que la simulación del backend usa como punto de partida:
  // contenedores 'disponible' que NO están comprometidos con ningún viaje
  // activo ajeno a esta ruta (otra ruta, o todavía sin rutear — bolsa, alta
  // manual, validación de pago). Es la MISMA lista contra la que se validan
  // los selects de contenedor de cada parada, así que el número de arriba no
  // puede quedar inflado con contenedores que después no se pueden asignar.
  const stockDeposito = ruta?.stock_deposito ?? [];

  async function agregarVaciado(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/api/rutas/${rutaId}/paradas/vaciado`, {
        ubicacion_id: vaciadoForm.ubicacion_id || undefined,
        notas: vaciadoForm.notas || undefined,
      });
      setAgregandoVaciado(false);
      setVaciadoForm({ ubicacion_id: '', notas: '' });
      cargar();
      show('success', 'Vaciado agregado a la ruta');
    } catch (err: any) {
      show('error', 'No se pudo agregar el vaciado', err.response?.data?.error);
    }
  }

  async function quitarParada(v: Visita) {
    if (!confirm('¿Quitar esta parada de la ruta? Vuelve a la bolsa de pedidos.')) return;
    // Optimista: la saca del panel al toque, sin esperar la ida y vuelta al
    // servidor — cargar() (abajo) trae el estado real igual, por las dudas.
    const previo = queryClient.getQueryData<RutaData>(['rutas', rutaId]);
    if (previo) {
      const idsAQuitar = new Set([v.entrega?.id, v.retiro?.id, v.vaciado?.id].filter(Boolean) as string[]);
      queryClient.setQueryData<RutaData>(['rutas', rutaId], {
        ...previo,
        paradas: previo.paradas.filter((p) => !idsAQuitar.has(p.id)),
      });
    }
    try {
      await api.delete(`/api/rutas/${rutaId}/paradas/${v.tipoParada}/${v.id}`);
      cargar();
    } catch (err: any) {
      if (previo) queryClient.setQueryData(['rutas', rutaId], previo);
      show('error', 'No se pudo quitar la parada', err.response?.data?.error);
    }
  }

  async function moverParadaA(tipo: 'viaje' | 'vaciado', paradaId: string, choferId: string) {
    let rutaDestino = rutasDelDia.find((r) => r.chofer_id === choferId);
    if (!rutaDestino) {
      try {
        const res = await api.post<Ruta>('/api/rutas', { fecha: ruta?.fecha, chofer_id: choferId });
        rutaDestino = res.data;
      } catch (err: any) {
        show('error', 'No se pudo crear la ruta de destino', err.response?.data?.error);
        return;
      }
    }
    // Optimista: la saca de la ruta actual al toque (un recambio mueve las
    // dos patas — misma grupo_id — como hace el backend).
    const previo = queryClient.getQueryData<RutaData>(['rutas', rutaId]);
    if (previo) {
      const objetivo = previo.paradas.find((p) => p.id === paradaId);
      const grupoId = objetivo && objetivo.tipo_parada === 'viaje' ? objetivo.grupo_id : null;
      queryClient.setQueryData<RutaData>(['rutas', rutaId], {
        ...previo,
        paradas: previo.paradas.filter((p) =>
          p.id !== paradaId && !(grupoId && p.tipo_parada === 'viaje' && p.grupo_id === grupoId),
        ),
      });
    }
    const rutaDestinoId = rutaDestino.id;
    try {
      await api.post(`/api/rutas/${rutaId}/paradas/${tipo}/${paradaId}/mover`, { ruta_destino_id: rutaDestinoId });
      const nombreDestino = choferes.find((c) => c.id === choferId)?.nombre ?? 'chofer';
      show('success', 'Parada movida', `Se movió la parada a la ruta de ${nombreDestino}.`);
      cargar();
      // Precalienta la ruta destino: si no se hace esto, React Query recién
      // dispara el fetch cuando el operador hace clic en ese chofer — la
      // demora que se nota "del otro lado" es esa primera carga en frío.
      queryClient.prefetchQuery({
        queryKey: ['rutas', rutaDestinoId],
        queryFn: () => api.get<RutaData>(`/api/rutas/${rutaDestinoId}`).then((r) => r.data),
      });
    } catch (err: any) {
      if (previo) queryClient.setQueryData(['rutas', rutaId], previo);
      show('error', 'No se pudo mover la parada', err.response?.data?.error);
    }
  }

  async function reordenar(nuevasVisitas: Visita[]) {
    // Evita que varios clicks seguidos en ↑/↓ (más rápido de lo que tarda la
    // ida y vuelta) disparen reordenamientos en paralelo con el mismo
    // `ruta.version` viejo: el primero pasa, todos los demás chocan con el
    // chequeo optimista del backend (409 "alguien más modificó la ruta") aun
    // sin que nadie más la haya tocado en verdad.
    if (reordenando) return;
    setReordenando(true);

    // Optimista: repinta el nuevo orden en el momento (es la acción más
    // frecuente al armar una ruta) — `disponibles` por parada queda
    // desactualizado hasta que cargar() traiga la simulación real del
    // backend, pero el reordenamiento visual no espera esa vuelta.
    const previo = queryClient.getQueryData<RutaData>(['rutas', rutaId]);
    if (previo) {
      const nuevasParadas: Parada[] = [];
      nuevasVisitas.forEach((v, i) => {
        const orden = i + 1;
        if (v.vaciado) nuevasParadas.push({ ...v.vaciado, orden });
        if (v.entrega) nuevasParadas.push({ ...v.entrega, orden });
        if (v.retiro) nuevasParadas.push({ ...v.retiro, orden });
      });
      queryClient.setQueryData<RutaData>(['rutas', rutaId], { ...previo, paradas: nuevasParadas });
    }
    try {
      await api.patch(`/api/rutas/${rutaId}/orden`, {
        secuencia: nuevasVisitas.map((v) => ({ tipo: v.tipoParada, id: v.id })),
        version: ruta?.version,
      });
      // Esperamos a que la caché tenga el version nuevo antes de soltar el
      // candado — si no, el próximo click todavía leería el version viejo.
      await queryClient.invalidateQueries({ queryKey: ['rutas', rutaId] });
      onCambio();
    } catch (err: any) {
      if (previo) queryClient.setQueryData(['rutas', rutaId], previo);
      if (err.response?.status === 409) {
        show('error', 'Esta ruta cambió', 'Otro usuario la modificó mientras tanto — se recargó con los cambios de él.');
        await queryClient.invalidateQueries({ queryKey: ['rutas', rutaId] });
        onCambio();
        setReordenando(false);
        return;
      }
      show('error', 'No se pudo reordenar', err.response?.data?.error);
    }
    setReordenando(false);
  }

  /** Saca la parada `from` y la reinserta en la posición `to` (drag & drop y flechas ↑/↓ pasan por acá). */
  function moverA(from: number, to: number) {
    if (from === to || reordenando) return;
    const nuevo = [...visitas];
    const [item] = nuevo.splice(from, 1);
    nuevo.splice(to, 0, item);
    reordenar(nuevo);
  }

  function mover(idx: number, direccion: -1 | 1) {
    const j = idx + direccion;
    if (j < 0 || j >= visitas.length) return;
    moverA(idx, j);
  }

  async function asignarContenedor(viajeId: string, contenedorNumero: string) {
    if (!contenedorNumero) return;
    // Optimista: el select ya se ve con el contenedor elegido antes de que
    // vuelva la confirmación del servidor.
    const previo = queryClient.getQueryData<RutaData>(['rutas', rutaId]);
    if (previo) {
      queryClient.setQueryData<RutaData>(['rutas', rutaId], {
        ...previo,
        paradas: previo.paradas.map((p) =>
          p.tipo_parada === 'viaje' && p.id === viajeId ? { ...p, contenedor_numero: contenedorNumero } : p,
        ),
      });
    }
    try {
      await api.patch(`/api/rutas/${rutaId}/paradas/${viajeId}/contenedor`, { contenedor_numero: contenedorNumero });
      cargar();
    } catch (err: any) {
      if (previo) queryClient.setQueryData(['rutas', rutaId], previo);
      show('error', 'No se pudo asignar el contenedor', err.response?.data?.error);
    }
  }

  async function confirmarRuta() {
    if (!confirm('¿Confirmar la ruta? Se reservan las paradas nuevas y se avisa al chofer por WhatsApp. Podés volver a confirmar más tarde si entra trabajo nuevo.')) return;
    setConfirmando(true);
    try {
      const { data } = await api.post<{ confirmadas: number; pendientes: string[] }>(`/api/rutas/${rutaId}/confirmar`);
      cargar();
      if (data.pendientes.length > 0) {
        show(
          'error',
          `${data.confirmadas} parada(s) confirmada(s), ${data.pendientes.length} pendiente(s)`,
          data.pendientes.join(' · '),
        );
      } else if (data.confirmadas > 0) {
        show('success', `${data.confirmadas} parada(s) confirmada(s)`, 'Se avisó al chofer por WhatsApp.');
      } else {
        show('success', 'Ya estaba todo confirmado', 'No había paradas nuevas para reservar.');
      }
    } catch (err: any) {
      show('error', 'No se pudo confirmar', err.response?.data?.error || 'Error desconocido');
    } finally {
      setConfirmando(false);
    }
  }

  async function cambiarEstado(estado: string) {
    try {
      await api.patch(`/api/rutas/${rutaId}`, { estado });
      cargar();
      show('success', 'Estado actualizado');
    } catch (err: any) {
      show('error', 'No se pudo actualizar el estado', err.response?.data?.error);
    }
  }

  if (!ruta) return null;

  const estado = ETIQUETA_ESTADO[ruta.estado];
  let invalid = 0;
  for (const v of visitas) {
    if (v.entrega && !v.entrega.contenedor_numero) invalid++;
    else if (v.entrega?.contenedor_numero && !(v.entrega.disponibles ?? []).includes(v.entrega.contenedor_numero)) invalid++;
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <div className="t">{ruta.chofer_nombre ?? 'Sin chofer'}</div>
          <div className="s">Patente {ruta.patente ?? '—'} · {formatearFecha(ruta.fecha)}</div>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <select className="form-select" style={{ width: 'auto', fontSize: '0.8rem' }} value={ruta.estado} onChange={(e) => cambiarEstado(e.target.value)}>
            <option value="planificada">Planificada</option>
            <option value="en_curso">En curso</option>
            <option value="finalizada">Finalizada</option>
            <option value="cancelada">Cancelada</option>
          </select>
          <span className={`badge ${estado.clase}`}>{estado.texto}</span>
        </div>
      </div>

      <RoleGate roles={['admin', 'operador']}>
        <div style={{ padding: '16px 18px' }}>
          <div className="abordo-label" style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
            Contenedores disponibles en depósito ({stockDeposito.length}):
          </div>
          <div className="abordo">
            {stockDeposito.length === 0 && <span className="cchip none">no hay contenedores libres en depósito</span>}
            {stockDeposito.map((c) => <span key={c} className="cchip">{c}</span>)}
          </div>

          {ruta.advertencias.length > 0 && (
            <div className="rc-warn" style={{ marginTop: '10px', marginBottom: '8px', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', background: 'var(--warning-bg)', padding: '8px 12px', borderRadius: 'var(--radius)' }}>
              {ruta.advertencias.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <AlertTriangle size={14} strokeWidth={2} /> {a.mensaje}
                </div>
              ))}
            </div>
          )}

          {visitas.length === 0 && <div className="rc-empty" style={{ margin: '16px 0' }}>Todavía no hay paradas en esta ruta — asigná desde la bolsa a la izquierda.</div>}
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            {visitas.map((v, idx) => {
              const disponibles = v.entrega?.disponibles ?? [];
              const necesitaContenedor = !!v.entrega;
              const sinAsignar = necesitaContenedor && !v.entrega!.contenedor_numero;
              const invalido = necesitaContenedor && !!v.entrega!.contenedor_numero && !disponibles.includes(v.entrega!.contenedor_numero!);
              return (
                <div
                  key={`${v.tipoParada}-${v.id}`}
                  className={`stop${dragIdx === idx ? ' dragging' : ''}${overIdx === idx && dragIdx !== null && dragIdx !== idx ? ' drop-target' : ''}`}
                  onDragOver={(e) => {
                    if (dragIdx === null) return;
                    e.preventDefault();
                    if (overIdx !== idx) setOverIdx(idx);
                  }}
                  onDrop={(e) => {
                    if (dragIdx === null) return;
                    e.preventDefault();
                    moverA(dragIdx, idx);
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                >
                  {editable && (
                    <span
                      className="stop-grip"
                      draggable={!reordenando}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        // Payload para soltar en la bolsa (sacar de la ruta); el
                        // reordenamiento dentro de la ruta usa dragIdx/overIdx.
                        e.dataTransfer.setData('application/x-mora-parada', JSON.stringify({
                          rutaId, tipoParada: v.tipoParada, paradaId: v.id,
                        }));
                        setDragIdx(idx);
                      }}
                      onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                      title="Arrastrá para reordenar, o soltá en la bolsa para sacarla de la ruta"
                    >
                      <GripVertical size={13} strokeWidth={2} />
                    </span>
                  )}
                  <div className="stop-ord">{idx + 1}</div>
                  <div className="stop-body">
                    {v.vaciado && (
                      <>
                        <div className="stop-top">
                          <div className="stop-cli">{v.vaciado.ubicacion_nombre ?? 'Depósito / vaciadero'}</div>
                          <span className="tag vaciado">Vaciado</span>
                        </div>
                        {v.vaciado.notas && <div className="stop-sub">{v.vaciado.notas}</div>}
                      </>
                    )}
                    {v.entrega && v.retiro && (
                      <>
                        <div className="stop-top">
                          <div className="stop-cli">
                            <DireccionMaps
                              direccion={v.retiro.destino_direccion ?? v.entrega.destino_direccion}
                              lat={v.retiro.destino_lat ?? v.entrega.destino_lat}
                              lng={v.retiro.destino_lng ?? v.entrega.destino_lng}
                            />
                          </div>
                          <span className="tag recambio"><RefreshCw size={11} strokeWidth={2} /> Recambio</span>
                        </div>
                        <div className="stop-sub">Lleno a retirar: {v.retiro.contenedor_numero}</div>
                        {(v.retiro.horario_preferido ?? v.entrega.horario_preferido) && (
                          <div className="stop-sub">🕐 Pidió: {v.retiro.horario_preferido ?? v.entrega.horario_preferido}</div>
                        )}
                        <div className="sel-row">
                          <label>Vacío a dejar:</label>
                          {editable ? (
                            <select
                              className={`form-select${(sinAsignar || invalido) ? ' err' : ''}`}
                              value={v.entrega.contenedor_numero ?? ''}
                              onChange={(e) => asignarContenedor(v.entrega!.id, e.target.value)}
                            >
                              <option value="">— elegir —</option>
                              {disponibles.map((c) => <option key={c} value={c}>{c}</option>)}
                              {invalido && <option value={v.entrega.contenedor_numero!}>{v.entrega.contenedor_numero} (ya no disp.)</option>}
                            </select>
                          ) : (
                            <span className="mono">{v.entrega.contenedor_numero ?? '—'}</span>
                          )}
                          {sinAsignar && disponibles.length === 0 && <span className="sel-warn">sin stock a bordo</span>}
                        </div>
                      </>
                    )}
                    {v.entrega && !v.retiro && (
                      <>
                        <div className="stop-top">
                          <div className="stop-cli">
                            <DireccionMaps direccion={v.entrega.destino_direccion} lat={v.entrega.destino_lat} lng={v.entrega.destino_lng} />
                          </div>
                          <span className="tag entrega">Entrega</span>
                        </div>
                        {v.entrega.horario_preferido && <div className="stop-sub">🕐 Pidió: {v.entrega.horario_preferido}</div>}
                        <div className="sel-row">
                          <label>Contenedor:</label>
                          {editable ? (
                            <select
                              className={`form-select${(sinAsignar || invalido) ? ' err' : ''}`}
                              value={v.entrega.contenedor_numero ?? ''}
                              onChange={(e) => asignarContenedor(v.entrega!.id, e.target.value)}
                            >
                              <option value="">— elegir —</option>
                              {disponibles.map((c) => <option key={c} value={c}>{c}</option>)}
                              {invalido && <option value={v.entrega.contenedor_numero!}>{v.entrega.contenedor_numero} (ya no disp.)</option>}
                            </select>
                          ) : (
                            <span className="mono">{v.entrega.contenedor_numero ?? '—'}</span>
                          )}
                          {sinAsignar && disponibles.length === 0 && <span className="sel-warn">sin stock a bordo</span>}
                        </div>
                      </>
                    )}
                    {v.retiro && !v.entrega && (
                      <>
                        <div className="stop-top">
                          <div className="stop-cli">
                            <DireccionMaps direccion={v.retiro.destino_direccion} lat={v.retiro.destino_lat} lng={v.retiro.destino_lng} />
                          </div>
                          <span className="tag retiro">Retiro</span>
                        </div>
                        <div className="stop-sub">{v.retiro.contenedor_numero}</div>
                        {v.retiro.horario_preferido && <div className="stop-sub">🕐 Pidió: {v.retiro.horario_preferido}</div>}
                      </>
                    )}
                  </div>

                  <div className="arrows">
                    <button disabled={idx === 0 || !editable || reordenando} onClick={() => mover(idx, -1)} title="Subir orden"><ArrowUp size={12} strokeWidth={2} /></button>
                    <button disabled={idx === visitas.length - 1 || !editable || reordenando} onClick={() => mover(idx, 1)} title="Bajar orden"><ArrowDown size={12} strokeWidth={2} /></button>
                  </div>

                  {editable && (
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginLeft: '6px' }}>
                      <select
                        className="form-select"
                        style={{ fontSize: '0.72rem', padding: '2px 6px', width: '110px' }}
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value) {
                            moverParadaA(v.tipoParada, v.id, e.target.value);
                            e.target.value = '';
                          }
                        }}
                        title="Reasignar parada a otro chofer"
                      >
                        <option value="" disabled>Mover a...</option>
                        {choferes.filter((c) => c.id !== ruta.chofer_id).map((c) => (
                          <option key={c.id} value={c.id}>{c.nombre}</option>
                        ))}
                      </select>
                      <button className="addbtn" onClick={() => quitarParada(v)} title="Quitar de la ruta"><X size={13} strokeWidth={2} /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {editable && (
            <div style={{ marginTop: '14px' }}>
              {agregandoVaciado ? (
                <form onSubmit={agregarVaciado} className="form-row">
                  <div className="form-group">
                    <label className="form-label">Vaciadero</label>
                    <select className="form-select" value={vaciadoForm.ubicacion_id} onChange={(e) => setVaciadoForm({ ...vaciadoForm, ubicacion_id: e.target.value })}>
                      <option value="">— Elegir —</option>
                      {vaciaderos.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Notas</label>
                    <input className="form-input" value={vaciadoForm.notas} onChange={(e) => setVaciadoForm({ ...vaciadoForm, notas: e.target.value })} />
                  </div>
                  <button type="submit" className="btn btn-primary btn-sm">Agregar</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAgregandoVaciado(false)}>Cancelar</button>
                </form>
              ) : (
                <button className="btn btn-ghost" onClick={() => setAgregandoVaciado(true)}>
                  <Plus size={14} strokeWidth={2} /> Agregar vaciado
                </button>
              )}
            </div>
          )}
        </div>

        <div className="detail-foot">
          <span className="valid-msg" style={{ color: invalid ? 'var(--danger)' : 'var(--success)' }}>
            {visitas.length === 0 ? '' : invalid ? `${invalid} parada(s) sin contenedor válido` : '✓ todas las paradas resueltas'}
          </span>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {editable && visitas.length > 0 && (
              <button className="btn btn-primary" onClick={confirmarRuta} disabled={confirmando}>
                <CheckCircle2 size={16} strokeWidth={1.75} /> {confirmando ? 'Confirmando...' : 'Confirmar ruta'}
              </button>
            )}
          </div>
        </div>
      </RoleGate>
    </div>
  );
}

// ── Página principal: layout 2 columnas (Bolsa a la izquierda, Choferes a la derecha) ────

export function Rutas() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [rutaSeleccionada, setRutaSeleccionada] = useState<string | null>(null);
  // Drag & drop de la bolsa a las rutas: `dragVisita` es la tarjeta que se
  // está arrastrando; `dropChofer` la tarjeta de chofer sobre la que está
  // parada ahora (para el resaltado), y `dropDetalle` lo mismo para el panel
  // de detalle abierto.
  const [dragVisita, setDragVisita] = useState<VisitaPendiente | null>(null);
  const [dropChofer, setDropChofer] = useState<string | null>(null);
  const [dropDetalle, setDropDetalle] = useState(false);
  // La bolsa también es zona de drop: soltar ahí una parada arrastrada desde
  // el detalle de una ruta la saca de esa ruta (vuelve a pedidos sin rutear).
  const [dropBolsa, setDropBolsa] = useState(false);
  // Pedido abierto en la ficha de detalle (al tocar una tarjeta de la bolsa).
  const [pedidoDetalle, setPedidoDetalle] = useState<VisitaPendiente | null>(null);

  const { data: choferes = [] } = useQuery({
    queryKey: ['choferes', 'activos'],
    queryFn: () => api.get<Chofer[]>('/api/choferes').then((r) => r.data.filter((c) => c.activo)),
  });
  const { data: rutas = [] } = useQuery({
    queryKey: ['rutas', fecha],
    queryFn: () => api.get<Ruta[]>(`/api/rutas?fecha=${fecha}`).then((r) => r.data),
  });
  const { data: cola = [] } = useQuery({
    queryKey: ['rutas', 'bolsa'],
    queryFn: () => api.get<ViajePendiente[]>('/api/rutas/bolsa').then((r) => r.data),
    refetchInterval: 15000,
  });
  const { data: viajesDelDia = [] } = useQuery({
    queryKey: ['viajes', 'del-dia', fecha],
    queryFn: () => api.get<ViajePendiente[]>(`/api/viajes?fecha=${fecha}&estado=programado`).then((r) => r.data),
  });
  // Rutas 'en_curso' de días anteriores al elegido: si nadie las cerró (ej.
  // camión roto, tareas que quedaron sin reasignar), el corte manual del día
  // (ver punto 8.1) no alcanza si nadie nota que la ruta vieja sigue abierta.
  const { data: rutasEnCursoTodas = [] } = useQuery({
    queryKey: ['rutas', 'en_curso'],
    queryFn: () => api.get<Ruta[]>('/api/rutas?estado=en_curso').then((r) => r.data),
    refetchInterval: 60000,
  });
  const rutasAbiertasAnteriores = rutasEnCursoTodas.filter((r) => r.fecha < fecha);

  const visitasPendientes = agruparPendientes(cola);
  const statsRutas = statsPorRuta(viajesDelDia);
  const visitasDelDia = agruparPendientes(viajesDelDia).length;
  const ruteados = agruparPendientes(viajesDelDia.filter((v) => v.ruta_id)).length;

  // Agrupamiento en dos niveles de los pedidos sin rutear: primero por día
  // puntual (una sección por cada fecha distinta, no por balde "Atrasados/
  // Próximos" — así no se mezclan pedidos de días distintos en una sola
  // sección larga) y dentro de cada día, por zona. La cola no filtra por
  // fecha a propósito, para no perder pedidos viejos de vista, así que hay
  // que ordenar para no perderlos.
  const bolsaAgrupada = (() => {
    const ordenadas = [...visitasPendientes].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const porFecha = new Map<string, Map<string, VisitaPendiente[]>>();
    for (const v of ordenadas) {
      const zona = v.zona ?? (v.destino_direccion ? v.destino_direccion.split(',')[0] : 'Sin zona');
      const porZona = porFecha.get(v.fecha) ?? new Map<string, VisitaPendiente[]>();
      const lista = porZona.get(zona) ?? [];
      lista.push(v);
      porZona.set(zona, lista);
      porFecha.set(v.fecha, porZona);
    }
    return [...porFecha.entries()].map(([fecha, zonasMap]) => ({
      fecha,
      categoria: categoriaDia(diasEspera(fecha)),
      titulo: tituloSeccionDia(fecha),
      zonas: [...zonasMap.entries()],
    }));
  })();

  // Selecciona la primera ruta del día automáticamente cuando cambia la fecha o cargan los datos.
  useEffect(() => {
    if (rutas.length === 0) { setRutaSeleccionada(null); return; }
    if (!rutas.some((r) => r.id === rutaSeleccionada)) setRutaSeleccionada(rutas[0].id);
  }, [rutas, rutaSeleccionada]);

  const recargarListas = () => {
    queryClient.invalidateQueries({ queryKey: ['rutas', fecha] });
    queryClient.invalidateQueries({ queryKey: ['rutas', 'bolsa'] });
    queryClient.invalidateQueries({ queryKey: ['viajes', 'del-dia', fecha] });
  };

  /** Agrega/confirma una ruta en la caché de la lista del día sin esperar el refetch de recargarListas(). */
  function agregarRutaOptimista(r: Ruta) {
    queryClient.setQueryData<Ruta[]>(['rutas', fecha], (prev = []) =>
      prev.some((x) => x.id === r.id) ? prev : [...prev, r]);
  }

  async function armarRuta(choferId: string) {
    try {
      const { data } = await api.post<Ruta>('/api/rutas', { fecha, chofer_id: choferId });
      // Optimista: la pestaña del chofer aparece al toque, sin esperar el
      // refetch — recargarListas() la reconfirma igual con el dato real.
      agregarRutaOptimista(data);
      recargarListas();
      setRutaSeleccionada(data.id);
    } catch (err: any) {
      show('error', 'No se pudo crear la ruta', err.response?.data?.error);
    }
  }

  async function asignarAChofer(visita: VisitaPendiente, choferId: string) {
    if (!choferId) return;

    // Asignar pisa la fecha del viaje con la de la ruta destino (ver backend,
    // no se toca a propósito). Si difieren, avisamos antes de mandar el POST:
    // un retiro/recambio depende de que el contenedor ya esté físicamente en
    // lo del cliente en su fecha, así que ahí el cartel es una advertencia
    // fuerte; una entrega pura sale de depósito, así que alcanza con confirmar.
    if (visita.fecha !== fecha) {
      const esRetiroOrecambio = !!visita.retiro;
      const mensaje = esRetiroOrecambio
        ? `⚠️ Este pedido tiene retiro programado para el ${formatearFecha(visita.fecha)} — el contenedor recién va a estar listo en lo del cliente esa fecha. Si lo asignás a la ruta del ${formatearFecha(fecha)}, el chofer podría salir a buscar algo que todavía no está preparado.\n\n¿Confirmás asignarlo igual?`
        : `Este pedido es para el ${formatearFecha(visita.fecha)}. ¿Confirmás que querés asignarlo a la ruta del ${formatearFecha(fecha)}?`;
      if (!confirm(mensaje)) return;
    }

    // Optimista: la saca de la bolsa al toque — antes se quedaba en pantalla
    // hasta que volvían las 3 queries que invalida recargarListas(), y esa
    // espera era la demora que más se notaba al armar una ruta.
    const previoCola = queryClient.getQueryData<ViajePendiente[]>(['rutas', 'bolsa']);
    if (previoCola) {
      const idsAQuitar = new Set([visita.entrega?.id, visita.retiro?.id, visita.id].filter(Boolean) as string[]);
      queryClient.setQueryData<ViajePendiente[]>(
        ['rutas', 'bolsa'],
        previoCola.filter((v) => !idsAQuitar.has(v.id)),
      );
    }

    // Idem para "Ruteados" y los contadores de paradas de cada chofer (tarjetas
    // de arriba y statsPorRuta): salían de viajesDelDia, que sólo se actualizaba
    // con el refetch de recargarListas() — ahí es donde más se sentían los
    // "segundos" antes de ver el pedido del lado del chofer.
    const previoViajesDelDia = queryClient.getQueryData<ViajePendiente[]>(['viajes', 'del-dia', fecha]);
    let rollbackViajesDelDia: (() => void) | null = null;

    try {
      let ruta = rutas.find((r) => r.chofer_id === choferId);
      if (!ruta) {
        const res = await api.post<Ruta>('/api/rutas', { fecha, chofer_id: choferId });
        ruta = res.data;
        agregarRutaOptimista(ruta);
      }

      // Sólo tiene sentido si el pedido es del día que se está viendo: si la
      // fecha difiere (caso del confirm() de arriba), no va a aparecer en
      // viajesDelDia de todos modos hasta que se refetchee con la fecha real.
      if (previoViajesDelDia && visita.fecha === fecha) {
        const idsAAsignar = new Set([visita.entrega?.id, visita.retiro?.id, visita.id].filter(Boolean) as string[]);
        // Orden provisorio (único, no colisiona con los reales): el backend
        // asigna el definitivo y el refetch de recargarListas() lo corrige.
        const ordenProvisorio = -Date.now();
        queryClient.setQueryData<ViajePendiente[]>(
          ['viajes', 'del-dia', fecha],
          previoViajesDelDia.map((v) =>
            idsAAsignar.has(v.id) ? { ...v, ruta_id: ruta!.id, orden: ordenProvisorio } : v,
          ),
        );
        rollbackViajesDelDia = () => queryClient.setQueryData(['viajes', 'del-dia', fecha], previoViajesDelDia);
      }

      // Optimista: agrega la parada directamente en la caché del detalle de la
      // ruta destino — sin esto, el viaje no aparece en el panel del chofer
      // hasta que vuelve el prefetchQuery (una ida y vuelta entera al servidor).
      const rutaId = ruta.id;
      const previoDetalle = queryClient.getQueryData<RutaData>(['rutas', rutaId]);
      if (previoDetalle) {
        const ordenProvisorio = (Math.max(0, ...previoDetalle.paradas.map((p) => p.orden)) + 1);
        const paradasNuevas: Parada[] = [];
        if (visita.entrega) {
          paradasNuevas.push({
            tipo_parada: 'viaje',
            id: visita.entrega.id,
            orden: ordenProvisorio,
            viaje_tipo: 'entrega',
            contenedor_numero: visita.entrega.contenedor_numero,
            destino_direccion: visita.entrega.destino_direccion,
            destino_lat: visita.entrega.destino_lat,
            destino_lng: visita.entrega.destino_lng,
            horario_preferido: visita.entrega.horario_preferido,
            hora_estimada: visita.entrega.hora_estimada ?? null,
            zona: visita.zona,
            cliente_telefono: visita.cliente_telefono,
            grupo_id: visita.entrega.grupo_id,
            estado: 'programado',
            notas: null,
          });
        }
        if (visita.retiro) {
          paradasNuevas.push({
            tipo_parada: 'viaje',
            id: visita.retiro.id,
            orden: ordenProvisorio,
            viaje_tipo: 'retiro',
            contenedor_numero: visita.retiro.contenedor_numero,
            destino_direccion: visita.retiro.destino_direccion,
            destino_lat: visita.retiro.destino_lat,
            destino_lng: visita.retiro.destino_lng,
            horario_preferido: visita.retiro.horario_preferido,
            hora_estimada: visita.retiro.hora_estimada ?? null,
            zona: visita.zona,
            cliente_telefono: visita.cliente_telefono,
            grupo_id: visita.retiro.grupo_id,
            estado: 'programado',
            notas: null,
          });
        }
        if (paradasNuevas.length > 0) {
          queryClient.setQueryData<RutaData>(['rutas', rutaId], {
            ...previoDetalle,
            paradas: [...previoDetalle.paradas, ...paradasNuevas],
          });
        }
      }

      const viajeId = visita.entrega?.id ?? visita.retiro?.id ?? visita.id;
      await api.post(`/api/rutas/${rutaId}/paradas`, { viaje_id: viajeId });
      const nombreChofer = choferes.find((c) => c.id === choferId)?.nombre ?? 'chofer';
      show('success', 'Pedido asignado', `Asignado a la ruta de ${nombreChofer}.`);
      setRutaSeleccionada(rutaId);
      recargarListas();
      // Refresca el detalle para traer el orden real del backend (el provisorio
      // era negativo, un placeholder) y los disponibles calculados por parada.
      queryClient.invalidateQueries({ queryKey: ['rutas', rutaId] });
    } catch (err: any) {
      if (previoCola) queryClient.setQueryData(['rutas', 'bolsa'], previoCola);
      rollbackViajesDelDia?.();
      show('error', 'No se pudo asignar el pedido', err.response?.data?.error || 'Error desconocido');
    }
  }

  /** Suelta la tarjeta arrastrada sobre la ruta de un chofer para asignarla. */
  function soltarEnChofer(choferId: string) {
    const visita = dragVisita;
    setDragVisita(null);
    setDropChofer(null);
    setDropDetalle(false);
    if (visita) asignarAChofer(visita, choferId);
  }

  /**
   * Saca una parada de su ruta (vuelve a la bolsa de pedidos sin rutear) — se
   * dispara al arrastrar una parada del detalle y soltarla sobre la bolsa.
   * Mismo endpoint que el botón "Quitar de la ruta" del detalle; una vez en
   * la bolsa se puede arrastrar a otro chofer para reasignarla.
   */
  async function quitarParadaDeRuta(p: { rutaId: string; tipoParada: 'viaje' | 'vaciado'; paradaId: string }) {
    try {
      await api.delete(`/api/rutas/${p.rutaId}/paradas/${p.tipoParada}/${p.paradaId}`);
      queryClient.invalidateQueries({ queryKey: ['rutas', p.rutaId] });
      recargarListas();
      show('success', 'Pedido devuelto a la bolsa', 'Arrastralo a otro chofer para reasignarlo.');
    } catch (err: any) {
      show('error', 'No se pudo quitar de la ruta', err.response?.data?.error || 'Error desconocido');
    }
  }

  /** Handlers de drop reutilizados por las dos variantes de tarjeta de chofer (con y sin ruta armada). */
  const propsDropChofer = (choferId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragVisita) return;
      e.preventDefault();
      if (dropChofer !== choferId) setDropChofer(choferId);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setDropChofer((c) => (c === choferId ? null : c));
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragVisita) return;
      e.preventDefault();
      soltarEnChofer(choferId);
    },
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Rutas</h2>
          <p>Planificá el recorrido de cada chofer.</p>
        </div>
        <div className="date-pick">Día: <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></div>
      </div>

      {rutasAbiertasAnteriores.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center',
          background: 'var(--warning-bg)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)',
          padding: '10px 14px', marginBottom: '16px', fontSize: '0.82rem',
        }}>
          <AlertTriangle size={16} strokeWidth={2} />
          <span>
            {rutasAbiertasAnteriores.length === 1 ? 'Quedó 1 ruta abierta de un día anterior sin cerrar:' : `Quedaron ${rutasAbiertasAnteriores.length} rutas abiertas de días anteriores sin cerrar:`}
          </span>
          {rutasAbiertasAnteriores.map((r) => (
            <button
              key={r.id}
              className="btn btn-ghost btn-sm"
              onClick={() => setFecha(r.fecha)}
              style={{ fontWeight: 700 }}
            >
              {r.chofer_nombre ?? 'Sin chofer'} · {formatearFecha(r.fecha)}
            </button>
          ))}
        </div>
      )}

      <div className="stats">
        <div className="stat"><div className="l">Pedidos del día</div><div className="n">{visitasDelDia}</div></div>
        <div className="stat"><div className="l">Ruteados</div><div className="n">{ruteados}</div></div>
        <div className="stat"><div className="l">Sin asignar</div><div className={`n${visitasPendientes.length ? ' warn' : ''}`}>{visitasPendientes.length}</div></div>
        <div className="stat"><div className="l">Choferes activos</div><div className="n">{choferes.length}</div></div>
      </div>

      {/* Grid principal en 2 columnas: Bolsa (Izquierda) | Choferes y Detalle (Derecha) */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '20px', alignItems: 'start' }}>
        
        {/* COLUMNA IZQUIERDA: Bolsa de pedidos sin rutear (también zona de drop para sacar paradas de una ruta) */}
        <div
          className={`card${dropBolsa ? ' bolsa-drop-activo' : ''}`}
          style={{ padding: '16px 18px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-mora-parada')) {
              e.preventDefault();
              if (!dropBolsa) setDropBolsa(true);
            }
          }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropBolsa(false); }}
          onDrop={(e) => {
            setDropBolsa(false);
            const raw = e.dataTransfer.getData('application/x-mora-parada');
            if (!raw) return;
            e.preventDefault();
            try {
              const p = JSON.parse(raw) as { rutaId: string; tipoParada: 'viaje' | 'vaciado'; paradaId: string };
              if (p.tipoParada === 'viaje') quitarParadaDeRuta(p);
            } catch { /* payload inválido: ignorar */ }
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', borderBottom: '1px solid var(--border)', paddingBottom: '10px' }}>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>📦 Pedidos sin rutear</span>
            </div>
            <span className="badge programado" style={{ fontSize: '0.75rem' }}>{visitasPendientes.length}</span>
          </div>

          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
            Tocá un pedido para ver el detalle. Arrastralo sobre un chofer para asignarlo, o arrastrá una parada de una ruta hasta acá para sacarla.
          </div>

          {visitasPendientes.length === 0 ? (
            <div className="rc-empty" style={{ textAlign: 'center', padding: '20px 0' }}>No hay pedidos pendientes en la bolsa.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxHeight: 'calc(100vh - 240px)', overflowY: 'auto', paddingRight: '4px' }}>
              {bolsaAgrupada.map(({ fecha, categoria, titulo, zonas }) => (
                <div key={fecha} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    fontSize: '0.78rem', fontWeight: 700,
                    color: categoria === 'atrasado' ? 'var(--danger)' : categoria === 'proximo' ? 'var(--text-muted)' : 'var(--text-primary)',
                    padding: '4px 8px', borderRadius: 'var(--radius-sm)',
                    background: categoria === 'atrasado' ? 'var(--warning-bg)' : 'transparent',
                  }}>
                    {categoria === 'atrasado' && <AlertTriangle size={13} strokeWidth={2} />}
                    {titulo}
                  </div>

                  {zonas.map(([zona, items]) => (
                    <div key={zona} style={{ display: 'flex', flexDirection: 'column', gap: '8px', opacity: categoria === 'proximo' ? 0.75 : 1 }}>
                      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--bg-surface)', padding: '4px 8px', borderRadius: 'var(--radius-sm)' }}>
                        📍 {zona} ({items.length})
                      </div>
                      {items.map((visita) => {
                    const fuenteDireccion = visita.destino_direccion
                      ? visita
                      : visita.entrega?.destino_direccion
                      ? visita.entrega
                      : visita.retiro?.destino_direccion
                      ? visita.retiro
                      : null;
                    const direccionPedido = fuenteDireccion?.destino_direccion
                      ?? (visita.zona ? `Zona ${visita.zona}` : 'Dirección sin especificar');
                    const horarioPedido = visita.horario_preferido
                      ?? visita.entrega?.horario_preferido
                      ?? visita.retiro?.horario_preferido
                      ?? null;
                    const dias = diasEspera(visita.fecha);
                    const espera = dias > DIAS_ALERTA_COLA;
                    const esFutura = dias < 0;
                    const detalleBase = visita.entrega ?? visita.retiro;
                    const nombrePedido = detalleBase?.cliente_nombre;
                    const importePedido = detalleBase?.importe != null && detalleBase.importe !== ''
                      ? Number(detalleBase.importe) : null;

                    return (
                      <div
                        key={visita.id}
                        className={`qrow${dragVisita?.id === visita.id ? ' dragging' : ''}`}
                        draggable
                        role="button"
                        tabIndex={0}
                        title="Tocá para ver el detalle · arrastrá para asignar"
                        onClick={(e) => {
                          // No abrir la ficha al tocar el link de Google Maps.
                          if ((e.target as HTMLElement).closest('a')) return;
                          setPedidoDetalle(visita);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPedidoDetalle(visita); }
                        }}
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragVisita(visita); }}
                        onDragEnd={() => { setDragVisita(null); setDropChofer(null); setDropDetalle(false); }}
                        style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px', padding: '10px 12px', cursor: 'grab' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                          <div>
                            <div className="cli" style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: '1.25' }}>
                              {fuenteDireccion
                                ? <DireccionMaps direccion={direccionPedido} lat={fuenteDireccion.destino_lat} lng={fuenteDireccion.destino_lng} />
                                : `📍 ${direccionPedido}`}
                            </div>
                            <div className="sub" style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                              {visita.entrega && visita.retiro ? 'Recambio' : visita.entrega ? 'Entrega' : 'Retiro'}
                              {nombrePedido ? ` · ${nombrePedido}` : ''}
                              {visita.cliente_telefono ? ` · 📞 ${visita.cliente_telefono}` : ''}
                              {horarioPedido ? ` · 🕐 ${horarioPedido}` : ''}
                              {importePedido != null ? ` · $${importePedido.toLocaleString('es-AR')}` : ''}
                              {' · '}
                              <span style={{
                                color: espera ? 'var(--danger)' : esFutura ? 'var(--text-muted)' : 'inherit',
                                fontStyle: esFutura ? 'italic' : 'normal',
                                fontWeight: espera ? 700 : 400,
                              }}>
                                {espera && <AlertTriangle size={11} strokeWidth={2} style={{ verticalAlign: '-1px', marginRight: '2px' }} />}
                                {etiquetaEspera(dias, visita.fecha)}
                              </span>
                            </div>
                          </div>
                          <span className={`tag ${visita.entrega && visita.retiro ? 'recambio' : visita.entrega ? 'entrega' : 'retiro'}`} style={{ fontSize: '0.68rem', padding: '2px 6px', flexShrink: 0 }}>
                            {visita.entrega && visita.retiro ? 'Recambio' : visita.entrega ? 'Entrega' : 'Retiro'}
                          </span>
                        </div>

                      </div>
                    );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* COLUMNA DERECHA: Rutas por Chofer + Detalle de Ruta */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <div className="section-title" style={{ marginBottom: '10px', fontSize: '0.9rem', fontWeight: 700 }}>
              Choferes y Rutas del Día
            </div>
            <div className="routes-grid">
              {choferes.map((chofer) => {
                const ruta = rutas.find((r) => r.chofer_id === chofer.id);
                if (!ruta) {
                  return (
                    <button
                      key={chofer.id}
                      className={`route-card${dropChofer === chofer.id ? ' drop-activo' : ''}`}
                      onClick={() => armarRuta(chofer.id)}
                      {...propsDropChofer(chofer.id)}
                    >
                      <div className="rc-head">
                        <div className="rc-av">{iniciales(chofer.nombre)}</div>
                        <div><div className="rc-nm">{chofer.nombre}</div><div className="rc-pat">—</div></div>
                        <span className="badge vacia">Vacía</span>
                      </div>
                      <div className="rc-lines">
                        <div className="rc-empty">Sin ruta armada</div>
                        <div className="rc-cta">+ Armar ruta</div>
                      </div>
                    </button>
                  );
                }
                const stats = statsRutas.get(ruta.id) ?? { paradas: 0, ent: 0, ret: 0, rec: 0, warn: 0 };
                const estado = ETIQUETA_ESTADO[ruta.estado];
                const sel = ruta.id === rutaSeleccionada;
                return (
                  <button
                    key={chofer.id}
                    className={`route-card${sel ? ' sel' : ''}${stats.warn ? ' warn' : ''}${dropChofer === chofer.id ? ' drop-activo' : ''}`}
                    onClick={() => setRutaSeleccionada(ruta.id)}
                    {...propsDropChofer(chofer.id)}
                  >
                    <div className="rc-head">
                      <div className="rc-av">{iniciales(chofer.nombre)}</div>
                      <div><div className="rc-nm">{chofer.nombre}</div><div className="rc-pat">{ruta.patente ?? '—'}</div></div>
                      <span className={`badge ${estado.clase}`}>{estado.texto}</span>
                    </div>
                    <div className="rc-lines">
                      <div className="rc-line"><span>Paradas</span><span className="v">{stats.paradas}</span></div>
                      <div className="rc-line"><span>Ent · ret · rec</span><span className="v">{stats.ent} · {stats.ret} · {stats.rec}</span></div>
                      {stats.warn > 0 && (
                        <div className="rc-warn"><AlertTriangle size={13} strokeWidth={2} /> {stats.warn} parada{stats.warn > 1 ? 's' : ''} sin contenedor</div>
                      )}
                      <div className="rc-cta">{sel ? 'Editando ahora ↓' : 'Abrir y editar →'}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {rutaSeleccionada ? (
            <div
              className={dropDetalle ? 'detalle-drop-activo' : undefined}
              onDragOver={(e) => {
                const choferSel = rutas.find((r) => r.id === rutaSeleccionada)?.chofer_id;
                if (!dragVisita || !choferSel) return;
                e.preventDefault();
                if (!dropDetalle) setDropDetalle(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropDetalle(false);
              }}
              onDrop={(e) => {
                const choferSel = rutas.find((r) => r.id === rutaSeleccionada)?.chofer_id;
                if (!dragVisita || !choferSel) return;
                e.preventDefault();
                soltarEnChofer(choferSel);
              }}
            >
              <div className="section-title" style={{ marginBottom: '10px', fontSize: '0.9rem', fontWeight: 700 }}>
                Detalle y Armado de Ruta
              </div>
              <DetalleRuta
                rutaId={rutaSeleccionada}
                rutasDelDia={rutas}
                choferes={choferes}
                onCambio={recargarListas}
              />
            </div>
          ) : (
            <div className="card empty-state" style={{ padding: '40px 20px' }}>
              <div className="empty-state-title">Ninguna ruta seleccionada</div>
              <div className="empty-state-text">Hacé clic en un chofer arriba para ver y armar su ruta, o asignale pedidos directamente desde la bolsa a la izquierda.</div>
            </div>
          )}
        </div>

      </div>

      {pedidoDetalle && (
        <PedidoDetalleModal
          visita={pedidoDetalle}
          choferes={choferes}
          esperaLabel={etiquetaEspera(diasEspera(pedidoDetalle.fecha), pedidoDetalle.fecha)}
          onAsignar={(choferId) => { asignarAChofer(pedidoDetalle, choferId); setPedidoDetalle(null); }}
          onClose={() => setPedidoDetalle(null)}
        />
      )}
    </div>
  );
}
