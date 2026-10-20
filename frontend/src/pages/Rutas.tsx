import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowUp, ArrowDown, ChevronsUp, ChevronsDown, Plus, X, RefreshCw, CheckCircle2, GripVertical, ChevronDown } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';
import { DireccionMaps } from '../components/DireccionMaps';
import { PedidoDetalleModal } from '../components/PedidoDetalleModal';
import { formatearFecha } from '../lib/fechas';
import { hoyISO } from '../lib/viajes';

interface Ruta {
  id: string;
  fecha: string;
  chofer_id: string;
  chofer_nombre: string | null;
  patente: string | null;
  notas: string | null;
  version: number;
  creado_en: string;
}
interface Chofer { id: string; nombre: string; activo: boolean; }
interface Ubicacion { id: string; tipo: 'deposito' | 'vaciadero'; nombre: string; activo: boolean; }
interface Tarifa { departamento: string; activo: boolean; }

// Mismas franjas que OPCIONES_HORARIO en horarioPreferido.flow.ts — el bot
// guarda exactamente estos textos en viajes.horario_preferido, así que un
// viaje armado a mano tiene que usar los mismos para que la columna
// "Horario sugerido" de Viajes se vea consistente.
const OPCIONES_HORARIO_SUGERIDO = ['🌅 Mañana (8-12hs)', '🕐 Tarde (12-15hs)'];

const formViajeInicial = {
  tipo: 'entrega', fecha: '', horario_preferido: '', zona: '',
  destino_direccion: '', importe: '', ubicacion_id: '',
};

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
  ruta_confirmada_en?: string | null;
  completada_en?: string | null;
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

interface StatsRuta { paradas: number; ent: number; ret: number; rec: number; warn: number; sinConfirmar: number; finalizadas: number; }
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
    let ent = 0, ret = 0, rec = 0, warn = 0, sinConfirmar = 0, finalizadas = 0;
    porOrden.forEach((visita) => {
      const entrega = visita.find((v) => v.tipo === 'entrega');
      const retiro = visita.find((v) => v.tipo === 'retiro');
      if (entrega && retiro) { rec++; if (!entrega.contenedor_numero) warn++; }
      else if (entrega) { ent++; if (!entrega.contenedor_numero) warn++; }
      else if (retiro) { ret++; }
      if (visita.some((v) => v.completada_en)) finalizadas++;
      else if (visita.some((v) => v.ruta_confirmada_en == null)) sinConfirmar++;
    });
    resultado.set(rutaId, { paradas: ent + ret + rec, ent, ret, rec, warn, sinConfirmar, finalizadas });
  });
  return resultado;
}

/**
 * La ruta ya no tiene `estado` propio: siempre está abierta. El badge se
 * deriva de las paradas — hay cambios sin confirmar, está toda completada, o
 * está en curso.
 */
function badgeRuta(s: { paradas: number; sinConfirmar: number; finalizadas: number }): { texto: string; clase: string } {
  if (s.paradas === 0) return { texto: 'Vacía', clase: 'vacia' };
  if (s.sinConfirmar > 0) return { texto: 'Sin confirmar', clase: 'sin_confirmar' };
  if (s.finalizadas >= s.paradas) return { texto: 'Completada', clase: 'completado' };
  return { texto: 'En curso', clase: 'en_curso' };
}

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
  completada_en: string | null;
  ruta_confirmada_en: string | null;
  disponibles?: string[];
}
interface ParadaVaciado {
  tipo_parada: 'vaciado';
  id: string;
  orden: number;
  ubicacion_id: string | null;
  ubicacion_nombre: string | null;
  notas: string | null;
  /** Qué contenedor se vacía acá — null en paradas viejas o agregadas sin elegir uno. */
  contenedor_numero: string | null;
  /** Estado REAL y en vivo de ese contenedor (contenedores.estado). 'retirado' = todavía lleno, esperando vaciarse. */
  contenedor_estado: string | null;
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
  /** Contenedores que este chofer ya tiene retirados (lleno) y sin vaciar todavía — para el selector de "Agregar vaciado" a mano. */
  contenedores_pendientes_vaciar: string[];
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

/** Una visita que el chofer ya marcó como hecha. */
function visitaFinalizada(v: Visita): boolean {
  return !!(v.entrega?.completada_en || v.retiro?.completada_en);
}

/**
 * La parada siguiente activa en ruta (a la que el chofer está yendo ahora mismo):
 * es la primera no finalizada de una ruta que ya tiene paradas confirmadas.
 */
function esVisitaEnCurso(v: Visita, visitas: Visita[]): boolean {
  if (visitaFinalizada(v)) return false;
  const tieneConfirmada = (v.entrega?.ruta_confirmada_en != null) || (v.retiro?.ruta_confirmada_en != null);
  if (!tieneConfirmada) return false;
  const primeraPendiente = visitas.find((item) => !visitaFinalizada(item));
  return primeraPendiente?.id === v.id;
}

/** Un punto de la guía "elegir chofer → agregar pedidos → confirmar ruta" en el detalle de una ruta. */
function PasoRuta({ estado, numero, label }: { estado: 'pendiente' | 'activo' | 'hecho'; numero?: number; label: string }) {
  const color = estado === 'hecho' ? 'var(--success)' : estado === 'activo' ? 'var(--accent)' : 'var(--border-light)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
      <div style={{
        width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0,
        background: estado === 'pendiente' ? 'var(--bg-surface)' : color,
        border: estado === 'pendiente' ? '1.5px solid var(--border-light)' : 'none',
        color: estado === 'pendiente' ? 'var(--text-muted)' : '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10.5px', fontWeight: 700,
      }}>
        {estado === 'hecho' ? '✓' : numero}
      </div>
      <span style={{ color: estado === 'activo' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: estado === 'activo' ? 700 : 500 }}>{label}</span>
    </div>
  );
}
function PasoLinea({ activa }: { activa: boolean }) {
  return <div style={{ width: '40px', height: '2px', background: activa ? 'var(--success)' : 'var(--border-light)', margin: '0 10px', flexShrink: 0 }} />;
}

function DetalleRuta({ rutaId, rutasDelDia, choferes, onCambio, pedidoArrastrado, onInsertarPedido }: {
  rutaId: string;
  rutasDelDia: Ruta[];
  choferes: Chofer[];
  onCambio: () => void;
  /** Hay un pedido de la bolsa arrastrándose ahora mismo (habilita soltar entre paradas). */
  pedidoArrastrado: boolean;
  /** Se soltó un pedido entre dos paradas: `orden` es la posición donde insertarlo. */
  onInsertarPedido: (orden: number) => void;
}) {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [agregandoVaciado, setAgregandoVaciado] = useState(false);
  const [vaciadoNotas, setVaciadoNotas] = useState('');
  const [vaciadoContenedor, setVaciadoContenedor] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [reordenando, setReordenando] = useState(false);
  // Índice de la parada sobre cuyo borde superior caería un pedido arrastrado desde la bolsa.
  const [insertIdx, setInsertIdx] = useState<number | null>(null);
  useEffect(() => { if (!pedidoArrastrado) setInsertIdx(null); }, [pedidoArrastrado]);
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
  const cargar = () => {
    queryClient.invalidateQueries({ queryKey: ['rutas', rutaId] });
    onCambio();
  };

  const visitas = ruta ? agruparVisitas(ruta.paradas) : [];
  // Para el selector de "Agregar vaciado" a mano: contenedores que este
  // chofer tiene retirados y sin vaciar, salvo los que ya tienen una parada
  // de vaciado propia en esta ruta (no tendría sentido ofrecerlos de nuevo).
  const contenedoresYaLinkeados = new Set(
    visitas.filter((v) => v.vaciado?.contenedor_numero).map((v) => v.vaciado!.contenedor_numero!),
  );
  const contenedoresPendientesSinLinkear = (ruta?.contenedores_pendientes_vaciar ?? [])
    .filter((n) => !contenedoresYaLinkeados.has(n));
  const listaParadasRef = useRef<HTMLDivElement>(null);
  useAnimarReacomodo(listaParadasRef, rutaId, visitas.map((v) => `${v.tipoParada}-${v.id}`).join('|'));
  // La ruta siempre está abierta ("ruta viva"): lo único que no se toca es una
  // parada que el chofer ya terminó (ver `visitaFinalizada`).
  const paradasSinConfirmar = ruta
    ? ruta.paradas.filter((p) => p.tipo_parada === 'viaje' && !p.completada_en && p.ruta_confirmada_en == null)
    : [];
  const hayCambiosSinConfirmar = paradasSinConfirmar.length > 0;

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
        contenedor_numero: vaciadoContenedor || undefined,
        notas: vaciadoNotas || undefined,
      });
      setAgregandoVaciado(false);
      setVaciadoNotas('');
      setVaciadoContenedor('');
      cargar();
      show('success', 'Vaciado agregado a la ruta');
    } catch (err: any) {
      show('error', 'No se pudo agregar el vaciado', err.response?.data?.error);
    }
  }

  /** Confirma desde el panel que el contenedor de esta parada ya se vació — mismo efecto que el chofer confirmando "🗑️ Ya vacié" por WhatsApp. */
  async function confirmarVaciado(paradaId: string, numero: string) {
    try {
      await api.post(`/api/rutas/${rutaId}/paradas/vaciado/${paradaId}/confirmar`);
      cargar();
      show('success', `Contenedor ${numero} marcado como vacío`);
    } catch (err: any) {
      show('error', 'No se pudo confirmar el vaciado', err.response?.data?.error);
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

  async function reordenar(nuevasVisitas: Visita[], gesto?: { visitaId: string; direccion: -1 | 1 }, esReintento = false, versionOverride?: number) {
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
        version: versionOverride ?? ruta?.version,
      });
      // Esperamos a que la caché tenga el version nuevo antes de soltar el
      // candado — si no, el próximo click todavía leería el version viejo.
      await queryClient.invalidateQueries({ queryKey: ['rutas', rutaId] });
      onCambio();
    } catch (err: any) {
      if (previo) queryClient.setQueryData(['rutas', rutaId], previo);
      if (err.response?.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['rutas', rutaId] });
        onCambio();
        // Perder el lock no tiene por qué perder el gesto del operador: se
        // reintenta UNA vez el mismo movimiento (misma parada, misma
        // dirección) sobre los datos frescos que se acaban de traer, en vez
        // de solo recargar y obligarlo a repetirlo a mano.
        if (gesto && !esReintento) {
          const fresca = await queryClient.fetchQuery<RutaData>({ queryKey: ['rutas', rutaId] });
          const visitasFrescas = agruparVisitas(fresca.paradas);
          const idx = visitasFrescas.findIndex((v) => v.id === gesto.visitaId);
          const j = idx + gesto.direccion;
          const puede = idx !== -1 && j >= 0 && j < visitasFrescas.length
            && !visitaFinalizada(visitasFrescas[idx]) && !visitaFinalizada(visitasFrescas[j])
            && !esVisitaEnCurso(visitasFrescas[idx], visitasFrescas) && !esVisitaEnCurso(visitasFrescas[j], visitasFrescas);
          if (puede) {
            const reintentada = [...visitasFrescas];
            const [item] = reintentada.splice(idx, 1);
            reintentada.splice(j, 0, item);
            setReordenando(false);
            return reordenar(reintentada, gesto, true, fresca.version);
          }
          show('error', 'Esta ruta cambió', 'Otro usuario la modificó mientras tanto — se recargó con los cambios de él.');
        } else {
          show('error', 'Esta ruta cambió', 'Otro usuario la modificó mientras tanto — se recargó con los cambios de él.');
        }
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
    // Una parada finalizada o en curso no se mueve, y tampoco se puede meter otra en su
    // lugar (el backend lo rechaza igual; esto evita el ida y vuelta).
    if (visitaFinalizada(visitas[from]) || visitaFinalizada(visitas[to]) ||
        esVisitaEnCurso(visitas[from], visitas) || esVisitaEnCurso(visitas[to], visitas)) {
      show('error', 'No se puede reordenar', 'La parada en curso o completada no se puede modificar.');
      return;
    }
    const nuevo = [...visitas];
    const [item] = nuevo.splice(from, 1);
    nuevo.splice(to, 0, item);
    // El gesto solo se puede reintentar sobre datos frescos cuando es un paso
    // simple (±1, el caso de las flechas y la mayoría de los drags) — un
    // movimiento de varias posiciones de una no tiene una "misma dirección"
    // clara para reaplicar, así que esos vuelven al comportamiento de antes.
    const gesto = Math.abs(to - from) === 1 ? { visitaId: item.id, direccion: (to > from ? 1 : -1) as -1 | 1 } : undefined;
    reordenar(nuevo, gesto);
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

  if (!ruta) return null;

  const finalizadasCount = visitas.filter(visitaFinalizada).length;
  const estado = badgeRuta({ paradas: visitas.length, sinConfirmar: paradasSinConfirmar.length, finalizadas: finalizadasCount });
  // Guía de "dónde estoy parado" armando esta ruta: elegir chofer ya pasó (se
  // llega acá después de tocar su tarjeta), agregar pedidos está en curso
  // mientras no haya ninguna parada, y confirmar queda pendiente hasta que no
  // quede ninguna parada sin confirmar.
  const pasoAgregar: 'activo' | 'hecho' = visitas.length === 0 ? 'activo' : 'hecho';
  const pasoConfirmar: 'pendiente' | 'activo' | 'hecho' =
    visitas.length === 0 ? 'pendiente' : hayCambiosSinConfirmar ? 'activo' : 'hecho';
  let invalid = 0;
  for (const v of visitas) {
    if (visitaFinalizada(v)) continue; // ya hecha: su contenedor no se toca más
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
        <span className={`badge ${estado.clase}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          {estado.clase === 'sin_confirmar' && <AlertTriangle size={12} strokeWidth={2.5} />}
          {estado.texto}
        </span>
      </div>

      {/* Guía de pasos: elegir chofer siempre está hecho acá (ya lo elegiste tocando su tarjeta). */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 18px 0', fontSize: '12px' }}>
        <PasoRuta estado="hecho" label="Elegir chofer" />
        <PasoLinea activa />
        <PasoRuta estado={pasoAgregar} numero={2} label="Agregar pedidos" />
        <PasoLinea activa={visitas.length > 0} />
        <PasoRuta estado={pasoConfirmar} numero={3} label="Confirmar ruta" />
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

          {hayCambiosSinConfirmar && (
            <div className="rc-warn confirmar-pendiente" style={{ marginTop: '10px', marginBottom: '8px', background: 'var(--warning-bg)', padding: '8px 12px', borderRadius: 'var(--radius)' }}>
              <AlertTriangle size={14} strokeWidth={2} />
              {paradasSinConfirmar.length === 1
                ? '1 parada sin confirmar — confirmá la ruta para reservar y avisarle al chofer.'
                : `${paradasSinConfirmar.length} paradas sin confirmar — confirmá la ruta para reservar y avisarle al chofer.`}
            </div>
          )}

          {visitas.length === 0 && <div className="rc-empty" style={{ margin: '16px 0' }}>Todavía no hay paradas en esta ruta — asigná desde la bolsa de arriba.</div>}
          
          <div ref={listaParadasRef} style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            {visitas.map((v, idx) => {
              const disponibles = v.entrega?.disponibles ?? [];
              const necesitaContenedor = !!v.entrega;
              const sinAsignar = necesitaContenedor && !v.entrega!.contenedor_numero;
              const invalido = necesitaContenedor && !!v.entrega!.contenedor_numero && !disponibles.includes(v.entrega!.contenedor_numero!);
              // Parada ya terminada por el chofer o en curso (chofer yendo ahora): intocable (sin grip, sin
              // flechas, sin "mover a", sin quitar, contenedor de solo lectura).
              const finalizada = visitaFinalizada(v);
              const enCurso = esVisitaEnCurso(v, visitas);
              const bloqueada = finalizada || enCurso;
              return (
                <div
                  key={`${v.tipoParada}-${v.id}`}
                  data-flip-key={`${v.tipoParada}-${v.id}`}
                  className={`stop${finalizada ? ' finalizada' : ''}${enCurso ? ' en-curso-bloqueada' : ''}${dragIdx === idx ? ' dragging' : ''}${overIdx === idx && dragIdx !== null && dragIdx !== idx ? ' drop-target' : ''}${insertIdx === idx ? ' insert-antes' : ''}`}
                  onDragOver={(e) => {
                    if (dragIdx !== null) {
                      e.preventDefault();
                      if (overIdx !== idx) setOverIdx(idx);
                    } else if (pedidoArrastrado && !bloqueada) {
                      // Soltar un pedido de la bolsa acá lo inserta ANTES de esta parada.
                      e.preventDefault();
                      e.stopPropagation();
                      if (insertIdx !== idx) setInsertIdx(idx);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (pedidoArrastrado && !e.currentTarget.contains(e.relatedTarget as Node)) {
                      setInsertIdx((i) => (i === idx ? null : i));
                    }
                  }}
                  onDrop={(e) => {
                    if (dragIdx !== null) {
                      e.preventDefault();
                      moverA(dragIdx, idx);
                      setDragIdx(null);
                      setOverIdx(null);
                    } else if (pedidoArrastrado && !bloqueada) {
                      e.preventDefault();
                      e.stopPropagation();
                      onInsertarPedido(v.orden);
                      setInsertIdx(null);
                    }
                  }}
                >
                  {!bloqueada && (
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
                      title="Arrastrá para reordenar, soltá sobre otro chofer para pasársela, o en la bolsa para sacarla de la ruta"
                    >
                      <GripVertical size={13} strokeWidth={2} />
                    </span>
                  )}
                  <div className="stop-ord">{idx + 1}</div>
                  <div className="stop-body">
                    {finalizada && (
                      <div className="stop-sub" style={{ color: 'var(--success)', fontWeight: 700 }}>✓ Finalizada por el chofer</div>
                    )}
                    {enCurso && (
                      <div className="stop-sub" style={{ color: 'var(--accent)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                        🚚 En camino (chofer realizando esta parada)
                      </div>
                    )}
                    {v.vaciado && (
                      <>
                        <div className="stop-top">
                          <div className="stop-cli">
                            {v.vaciado.contenedor_numero
                              ? `Vaciar contenedor ${v.vaciado.contenedor_numero}`
                              : v.vaciado.ubicacion_nombre ?? 'Depósito / vaciadero'}
                          </div>
                          <span className="tag vaciado">Vaciado</span>
                        </div>
                        {v.vaciado.contenedor_numero && (
                          <div className="sel-row" style={{ alignItems: 'center' }}>
                            {v.vaciado.contenedor_estado === 'retirado' ? (
                              <>
                                <span className="sel-warn">🔴 Lleno, todavía sin vaciar</span>
                                <button
                                  type="button"
                                  className="btn btn-success btn-sm"
                                  onClick={() => confirmarVaciado(v.vaciado!.id, v.vaciado!.contenedor_numero!)}
                                  title="Marca el contenedor como vacío — lo mismo que hace el chofer confirmando por WhatsApp"
                                >
                                  ✅ Marcar vaciado
                                </button>
                              </>
                            ) : v.vaciado.contenedor_estado === 'entregado' ? (
                              <span style={{ color: 'var(--text-muted)' }}>⏳ Esperando que el chofer lo retire del cliente</span>
                            ) : (
                              <span style={{ color: 'var(--success)', fontWeight: 600 }}>✅ Ya está vacío</span>
                            )}
                          </div>
                        )}
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
                        {(v.retiro.zona ?? v.entrega.zona) && <div className="stop-sub">📍 {v.retiro.zona ?? v.entrega.zona}</div>}
                        <div className="stop-sub">Lleno a retirar: {v.retiro.contenedor_numero}</div>
                        {(v.retiro.cliente_telefono ?? v.entrega.cliente_telefono) && (
                          <div className="stop-sub">📞 {v.retiro.cliente_telefono ?? v.entrega.cliente_telefono}</div>
                        )}
                        {(v.retiro.horario_preferido ?? v.entrega.horario_preferido) && (
                          <div className="stop-sub">🕐 Pidió: {v.retiro.horario_preferido ?? v.entrega.horario_preferido}</div>
                        )}
                        <div className="sel-row">
                          <label>Vacío a dejar:</label>
                          {!bloqueada ? (
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
                        {v.entrega.zona && <div className="stop-sub">📍 {v.entrega.zona}</div>}
                        {v.entrega.cliente_telefono && <div className="stop-sub">📞 {v.entrega.cliente_telefono}</div>}
                        {v.entrega.horario_preferido && <div className="stop-sub">🕐 Pidió: {v.entrega.horario_preferido}</div>}
                        <div className="sel-row">
                          <label>Contenedor:</label>
                          {!bloqueada ? (
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
                        {v.retiro.zona && <div className="stop-sub">📍 {v.retiro.zona}</div>}
                        <div className="stop-sub">{v.retiro.contenedor_numero}</div>
                        {v.retiro.cliente_telefono && <div className="stop-sub">📞 {v.retiro.cliente_telefono}</div>}
                        {v.retiro.horario_preferido && <div className="stop-sub">🕐 Pidió: {v.retiro.horario_preferido}</div>}
                      </>
                    )}
                  </div>

                  <div className="arrows">
                    {visitas.length > 3 && (
                      <button disabled={idx === 0 || bloqueada || reordenando} onClick={() => moverA(idx, 0)} title="Mover al tope"><ChevronsUp size={12} strokeWidth={2} /></button>
                    )}
                    <button disabled={idx === 0 || bloqueada || reordenando} onClick={() => mover(idx, -1)} title="Subir orden"><ArrowUp size={12} strokeWidth={2} /></button>
                    <button disabled={idx === visitas.length - 1 || bloqueada || reordenando} onClick={() => mover(idx, 1)} title="Bajar orden"><ArrowDown size={12} strokeWidth={2} /></button>
                    {visitas.length > 3 && (
                      <button disabled={idx === visitas.length - 1 || bloqueada || reordenando} onClick={() => moverA(idx, visitas.length - 1)} title="Mover al final"><ChevronsDown size={12} strokeWidth={2} /></button>
                    )}
                  </div>

                  {!bloqueada && (
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

          <div style={{ marginTop: '14px' }}>
            {agregandoVaciado ? (
              <form onSubmit={agregarVaciado} className="form-row">
                <div className="form-group">
                  <label className="form-label">Contenedor (opcional)</label>
                  <select
                    className="form-select"
                    value={vaciadoContenedor}
                    onChange={(e) => setVaciadoContenedor(e.target.value)}
                    autoFocus
                  >
                    <option value="">— Sin elegir —</option>
                    {contenedoresPendientesSinLinkear.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Notas (opcional)</label>
                  <input
                    className="form-input"
                    placeholder="Ej: lo vació el chofer al volver"
                    value={vaciadoNotas}
                    onChange={(e) => setVaciadoNotas(e.target.value)}
                  />
                </div>
                <button type="submit" className="btn btn-primary btn-sm">Agregar</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAgregandoVaciado(false); setVaciadoNotas(''); setVaciadoContenedor(''); }}>Cancelar</button>
              </form>
            ) : (
              <button className="btn btn-ghost" onClick={() => setAgregandoVaciado(true)} title="Vaciado manual del contenedor que ya tiene el chofer (no hace falta elegir vaciadero)">
                <Plus size={14} strokeWidth={2} /> Agregar vaciado
              </button>
            )}
          </div>
        </div>

        <div className="detail-foot">
          <span className="valid-msg" style={{ color: invalid ? 'var(--danger)' : 'var(--success)' }}>
            {visitas.length === 0 ? '' : invalid ? `${invalid} parada(s) sin contenedor válido` : '✓ todas las paradas resueltas'}
          </span>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {visitas.length > 0 && (
              <button className={`btn btn-primary${hayCambiosSinConfirmar ? ' confirmar-pendiente' : ''}`} onClick={confirmarRuta} disabled={confirmando}>
                <CheckCircle2 size={16} strokeWidth={1.75} /> {confirmando ? 'Confirmando...' : hayCambiosSinConfirmar ? 'Confirmar cambios' : 'Confirmar ruta'}
              </button>
            )}
          </div>
        </div>
      </RoleGate>
    </div>
  );
}

// ── Auto-armado de rutas (Nivel 1): agrupa la bolsa del día por zona+horario y la ────
// reparte entre choferes activos como PROPUESTA editable — no escribe nada en la base
// hasta "Confirmar y armar", que recién ahí usa los mismos endpoints que el armado a
// mano (POST /api/rutas + POST /api/rutas/:id/paradas). No dispara ningún aviso al
// chofer: la ruta queda "sin confirmar" igual que una armada a mano, a la espera del
// botón "Confirmar ruta" de siempre.

interface ClusterPropuesto {
  id: string;
  zona: string;
  horario: string | null;
  visitas: VisitaPendiente[];
}
interface AsignacionChofer {
  choferId: string;
  choferNombre: string;
  clusters: ClusterPropuesto[];
}

function cargaTotal(a: AsignacionChofer): number {
  return a.clusters.reduce((n, c) => n + c.visitas.length, 0);
}

/** Agrupa por zona+horario y reparte cada cluster al chofer con menos carga hasta ahora (greedy, sin geocoding). */
function armarPropuesta(visitas: VisitaPendiente[], choferes: Chofer[]): AsignacionChofer[] {
  const porClave = new Map<string, ClusterPropuesto>();
  for (const v of visitas) {
    const zona = v.zona ?? (v.destino_direccion ? v.destino_direccion.split(',')[0] : 'Sin zona');
    const horario = v.horario_preferido ?? null;
    const clave = `${zona}__${horario ?? 'sin-horario'}`;
    const c = porClave.get(clave) ?? { id: clave, zona, horario, visitas: [] };
    c.visitas.push(v);
    porClave.set(clave, c);
  }
  const clusters = [...porClave.values()].sort((a, b) => b.visitas.length - a.visitas.length);

  const asignaciones: AsignacionChofer[] = choferes.map((c) => ({ choferId: c.id, choferNombre: c.nombre, clusters: [] }));
  if (asignaciones.length === 0) return [];
  for (const cluster of clusters) {
    asignaciones.sort((a, b) => cargaTotal(a) - cargaTotal(b));
    asignaciones[0].clusters.push(cluster);
  }
  return asignaciones;
}

/** Mañana primero, después tarde, al final el resto (barrio privado, sin franja). */
function rangoHorario(horario: string | null): number {
  const t = (horario ?? '').toLowerCase();
  if (t.includes('mañana')) return 0;
  if (t.includes('tarde')) return 1;
  return 2;
}

/** Orden en que se agregan a la ruta los pedidos que le tocaron a un chofer: por franja horaria y, dentro de cada franja, agrupados por zona. */
function ordenarParaRuta(visitas: VisitaPendiente[]): VisitaPendiente[] {
  return [...visitas].sort(
    (a, b) =>
      rangoHorario(a.horario_preferido) - rangoHorario(b.horario_preferido) ||
      (a.zona ?? '').localeCompare(b.zona ?? ''),
  );
}

/**
 * Animación corta cuando las paradas de una ruta cambian de lugar (técnica
 * FLIP): cada parada que se movió arranca desde su posición anterior y se
 * desliza a la nueva, y las que recién aparecen entran con un fundido. Usa
 * offsetTop (relativo a la lista) y no la posición en pantalla, así un
 * scroll entre dos cambios no se toma como un movimiento. No anima al abrir
 * otra ruta ni si el sistema pide reducir animaciones.
 */
function useAnimarReacomodo(ref: React.RefObject<HTMLDivElement>, rutaId: string, clave: string) {
  const posiciones = useRef<Map<string, number>>(new Map());
  const rutaAnterior = useRef<string | null>(null);
  useLayoutEffect(() => {
    const lista = ref.current;
    if (!lista) return;
    const animar =
      rutaAnterior.current === rutaId &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nuevas = new Map<string, number>();
    for (const el of Array.from(lista.children) as HTMLElement[]) {
      const k = el.dataset.flipKey;
      if (!k) continue;
      nuevas.set(k, el.offsetTop);
      if (!animar) continue;
      const antes = posiciones.current.get(k);
      if (antes === undefined) {
        el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
      } else if (antes !== el.offsetTop) {
        el.animate([{ transform: `translateY(${antes - el.offsetTop}px)` }, { transform: 'none' }], { duration: 260, easing: 'ease-out' });
      }
    }
    posiciones.current = nuevas;
    rutaAnterior.current = rutaId;
  }, [ref, rutaId, clave]);
}

// ── Página principal: layout apilado (Bolsa arriba, Choferes y Detalle abajo) ────

export function Rutas() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const paramFecha = searchParams.get('fecha');
  const paramNuevo = searchParams.get('nuevo');

  const [fecha, setFecha] = useState(() => paramFecha || hoyISO());
  const [rutaSeleccionada, setRutaSeleccionada] = useState<string | null>(null);

  // Sincronizar fecha si cambia en la URL
  useEffect(() => {
    if (paramFecha && paramFecha !== fecha) {
      setFecha(paramFecha);
    }
  }, [paramFecha]);
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

  // Form "Programar nuevo viaje" (antes vivía en Viajes.tsx).
  const [formViaje, setFormViaje] = useState(() => ({ ...formViajeInicial, fecha: paramFecha || hoyISO() }));
  const [mostrarFormViaje, setMostrarFormViaje] = useState(() => paramNuevo === '1');
  const [creandoViaje, setCreandoViaje] = useState(false);
  const [autoArmando, setAutoArmando] = useState(false);
  // Último auto-armado, para poder deshacerlo: el aviso queda fijo hasta cerrarlo o volver a auto-armar.
  const [ultimoAutoArmado, setUltimoAutoArmado] = useState<{
    paradas: { rutaId: string; viajeId: string }[];
    rutasCreadas: string[];
    resumen: string;
  } | null>(null);
  // Choferes cuya tarjeta destella porque el auto-armado les sumó pedidos.
  const [choferesDestello, setChoferesDestello] = useState<Set<string>>(new Set());
  // Un día sin rutas armadas muestra igual las tarjetas vacías de todos los
  // choferes — con una flota grande es puro ruido visual la mayoría de los días.
  const [ocultarSinRuta, setOcultarSinRuta] = useState(false);

  useEffect(() => {
    if (paramNuevo === '1') {
      setMostrarFormViaje(true);
    }
  }, [paramNuevo]);

  const { data: choferes = [] } = useQuery({
    queryKey: ['choferes', 'activos'],
    queryFn: () => api.get<Chofer[]>('/api/choferes').then((r) => r.data.filter((c) => c.activo)),
  });
  const { data: zonasTarifas = [] } = useQuery({
    queryKey: ['tarifas', 'activas'],
    queryFn: () => api.get<Tarifa[]>('/api/tarifas').then((r) => r.data.filter((t) => t.activo)),
  });
  const { data: ubicacionesViaje = [] } = useQuery({
    queryKey: ['ubicaciones'],
    queryFn: () => api.get<Ubicacion[]>('/api/ubicaciones').then((r) => r.data.filter((u) => u.activo)),
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
  // Rutas de días anteriores con paradas pendientes (confirmadas, avisadas al
  // chofer, todavía sin completar): si quedó trabajo colgado de un día anterior
  // (camión roto, paradas sin reasignar) hay que verlo — la ruta ya no "se
  // cierra", así que esto se deriva de las paradas.
  const { data: rutasConPendientes = [] } = useQuery({
    queryKey: ['rutas', 'pendientes'],
    queryFn: () => api.get<Ruta[]>('/api/rutas?pendientes=1').then((r) => r.data),
    refetchInterval: 60000,
  });
  const rutasAbiertasAnteriores = rutasConPendientes.filter((r) => r.fecha < fecha);

  const visitasPendientes = agruparPendientes(cola);
  // "Sin asignar" mezclaba el backlog TOTAL (toda fecha) con lo específico de
  // este día — al cambiar de fecha el número no se movía y confundía backlog
  // viejo con lo de hoy. Se muestran separados.
  const sinAsignarDelDia = visitasPendientes.filter((v) => v.fecha === fecha).length;
  const statsRutas = statsPorRuta(viajesDelDia);
  const visitasDelDia = agruparPendientes(viajesDelDia).length;
  const ruteados = agruparPendientes(viajesDelDia.filter((v) => v.ruta_id)).length;
  // Rutas con paradas agregadas (a mano o por auto-armado) que todavía no se
  // confirmaron: mientras sigan así, el chofer nunca se entera de ese viaje
  // — este número es lo que faltaría tocar "Confirmar ruta" para resolver.
  const rutasSinConfirmar = rutas.filter((r) => badgeRuta(statsRutas.get(r.id) ?? { paradas: 0, sinConfirmar: 0, finalizadas: 0 }).clase === 'sin_confirmar').length;

  // Agrupamiento en dos niveles de los pedidos sin rutear: primero por día
  // puntual (una sección por cada fecha distinta, no por balde "Atrasados/
  // Próximos" — así no se mezclan pedidos de días distintos en una sola
  // sección larga) y dentro de cada día, por zona. La cola no filtra por
  // fecha a propósito, para no perder pedidos viejos de vista, así que hay
  // que ordenar para no perderlos.
  const bolsaAgrupada = (() => {
    const ordenadas = [...visitasPendientes]
      .filter((v) => v.fecha === fecha)
      .sort((a, b) => a.fecha.localeCompare(b.fecha));
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

  /** Cancela un pedido de la bolsa (todavía sin rutear) y le avisa al cliente por WhatsApp. */
  async function cancelarPedidoDeBolsa(visita: VisitaPendiente) {
    if (!confirm('¿Cancelar este pedido? Le vamos a avisar al cliente por WhatsApp.')) return;
    const viajeId = visita.entrega?.id ?? visita.retiro?.id;
    if (!viajeId) return;
    try {
      await api.post(`/api/rutas/bolsa/${viajeId}/cancelar`);
      recargarListas();
      show('success', 'Pedido cancelado', 'Le avisamos al cliente por WhatsApp.');
    } catch (err: any) {
      show('error', 'No se pudo cancelar', err.response?.data?.error || 'Error desconocido');
    }
  }

  // Depósito para una entrega, vaciadero para un retiro. Si hay una sola
  // activa de ese tipo no hace falta elegir: el backend la autoasigna sola.
  const tipoUbicacionViaje = formViaje.tipo === 'entrega' ? 'deposito' : 'vaciadero';
  const ubicacionesElegiblesViaje = ubicacionesViaje.filter((u) => u.tipo === tipoUbicacionViaje);

  /** Programa un viaje (o recambio) nuevo — cae directo a la bolsa sin rutear. */
  async function crearViaje(e: React.FormEvent) {
    e.preventDefault();
    if (!formViaje.fecha) return;
    setCreandoViaje(true);
    try {
      await api.post('/api/viajes', {
        ...formViaje,
        zona: formViaje.zona || undefined,
        destino_direccion: formViaje.destino_direccion || undefined,
        importe: formViaje.importe || undefined,
        ubicacion_id: formViaje.ubicacion_id || undefined,
        horario_preferido: formViaje.horario_preferido || undefined,
      });
      setFormViaje(formViajeInicial);
      recargarListas();
      queryClient.invalidateQueries({ queryKey: ['viajes'] });
      show('success', formViaje.tipo === 'recambio' ? 'Recambio programado correctamente' : 'Viaje programado correctamente');
    } catch (err: any) {
      show('error', 'Error al programar', err.response?.data?.error || 'Error desconocido');
    } finally {
      setCreandoViaje(false);
    }
  }

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

  /** `ordenDestino` = posición (valor de `orden`) donde insertar la parada; sin él, va al final. */
  async function asignarAChofer(visita: VisitaPendiente, choferId: string, ordenDestino?: number) {
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
        // Si se pidió una posición, un orden fraccionario (x.5) hace que la
        // parada nueva caiga justo antes de la que está en `x` mientras
        // vuelve el refetch con el orden entero real; si no, va al final.
        const ordenProvisorio = ordenDestino != null
          ? ordenDestino - 0.5
          : (Math.max(0, ...previoDetalle.paradas.map((p) => p.orden)) + 1);
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
            completada_en: null,
            ruta_confirmada_en: null,
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
            completada_en: null,
            ruta_confirmada_en: null,
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
      await api.post(`/api/rutas/${rutaId}/paradas`, { viaje_id: viajeId, orden: ordenDestino });
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

  /**
   * Auto-armado directo, sin ventana: reparte los pedidos del día que están
   * en la bolsa entre todos los choferes activos (agrupados por zona y
   * horario, cada grupo al que menos carga lleva — ver armarPropuesta) y los
   * agrega al final de cada ruta, ordenados por franja y zona. Las paradas
   * que ya estaban no se tocan. Queda sin confirmar, igual que armado a
   * mano: nadie recibe aviso hasta tocar "Confirmar ruta". Se puede deshacer
   * hasta que se cierre el aviso o se vuelva a auto-armar.
   */
  async function autoArmarRutas() {
    const visitasDelDia = agruparPendientes(cola).filter((v) => v.fecha === fecha && (v.entrega?.id ?? v.retiro?.id));
    if (visitasDelDia.length === 0) {
      show('info', 'Nada para armar', 'No hay pedidos sin rutear para este día.');
      return;
    }
    if (choferes.length === 0) {
      show('error', 'No hay choferes activos', 'Cargá al menos un chofer para poder armar rutas.');
      return;
    }
    setAutoArmando(true);
    const paradas: { rutaId: string; viajeId: string }[] = [];
    const rutasCreadas: string[] = [];
    const choferesConCambios = new Set<string>();
    const errores: string[] = [];
    for (const a of armarPropuesta(visitasDelDia, choferes)) {
      const visitasChofer = ordenarParaRuta(a.clusters.flatMap((c) => c.visitas));
      if (visitasChofer.length === 0) continue;
      let rutaId: string;
      try {
        const existentes = await api.get<Ruta[]>(`/api/rutas?fecha=${fecha}&chofer_id=${a.choferId}`).then((r) => r.data);
        if (existentes[0]) {
          rutaId = existentes[0].id;
        } else {
          const nueva = await api.post<Ruta>('/api/rutas', { fecha, chofer_id: a.choferId }).then((r) => r.data);
          rutaId = nueva.id;
          rutasCreadas.push(rutaId);
          agregarRutaOptimista(nueva);
        }
      } catch (e: any) {
        errores.push(`${a.choferNombre}: ${e.response?.data?.error ?? 'no se pudo crear la ruta'}`);
        continue;
      }
      for (const v of visitasChofer) {
        const viajeId = (v.entrega?.id ?? v.retiro?.id)!;
        try {
          await api.post(`/api/rutas/${rutaId}/paradas`, { viaje_id: viajeId });
          paradas.push({ rutaId, viajeId });
          choferesConCambios.add(a.choferId);
        } catch (e: any) {
          errores.push(`${a.choferNombre} · ${v.cliente_telefono ?? viajeId}: ${e.response?.data?.error ?? 'error'}`);
        }
      }
      queryClient.invalidateQueries({ queryKey: ['rutas', rutaId] });
    }
    setAutoArmando(false);
    recargarListas();

    if (paradas.length > 0) {
      // Si la ruta que estaba abierta no cambió, se abre la primera que sí, para ver cómo quedó.
      if (!paradas.some((p) => p.rutaId === rutaSeleccionada)) setRutaSeleccionada(paradas[0].rutaId);
      setChoferesDestello(choferesConCambios);
      setTimeout(() => setChoferesDestello(new Set()), 1200);
      const resumen = `${paradas.length} pedido(s) repartidos entre ${choferesConCambios.size} chofer(es) — quedan sin confirmar.`;
      setUltimoAutoArmado({ paradas, rutasCreadas, resumen });
    }
    if (errores.length > 0) {
      show('error', `${errores.length} pedido(s) no se pudieron asignar`, errores.slice(0, 3).join(' · '));
    }
  }

  /** Vuelve a la bolsa todo lo que agregó el último auto-armado y borra las rutas que creó (si el rol lo permite). */
  async function deshacerAutoArmado() {
    const u = ultimoAutoArmado;
    if (!u) return;
    setUltimoAutoArmado(null);
    let fallidas = 0;
    for (const p of u.paradas) {
      try {
        await api.delete(`/api/rutas/${p.rutaId}/paradas/viaje/${p.viajeId}`);
      } catch {
        fallidas++;
      }
      queryClient.invalidateQueries({ queryKey: ['rutas', p.rutaId] });
    }
    // Borrar una ruta es solo para admin: para un operador, la ruta vacía queda y no molesta.
    for (const rutaId of u.rutasCreadas) {
      await api.delete(`/api/rutas/${rutaId}`).catch(() => {});
    }
    recargarListas();
    if (fallidas === 0) show('info', 'Auto-armado deshecho', 'Los pedidos volvieron a la bolsa.');
    else show('error', 'Se deshizo en parte', `${fallidas} pedido(s) no se pudieron sacar (por ejemplo, porque el chofer ya los empezó).`);
  }

  /**
   * Mueve una parada ya ruteada a la ruta de otro chofer — se dispara al
   * arrastrar una parada del detalle y soltarla sobre la tarjeta de ese
   * chofer. Mismo endpoint que el selector "Mover a..." del detalle (un
   * recambio mueve sus dos patas); si el chofer todavía no tiene ruta ese
   * día, se la crea primero, igual que ahí.
   */
  async function moverParadaAChofer(p: { rutaId: string; tipoParada: 'viaje' | 'vaciado'; paradaId: string }, choferId: string) {
    let rutaDestinoId = rutas.find((r) => r.chofer_id === choferId)?.id;
    if (rutaDestinoId === p.rutaId) return; // soltada sobre su propio chofer
    try {
      if (!rutaDestinoId) {
        const { data } = await api.post<Ruta>('/api/rutas', { fecha, chofer_id: choferId });
        agregarRutaOptimista(data);
        rutaDestinoId = data.id;
      }
      await api.post(`/api/rutas/${p.rutaId}/paradas/${p.tipoParada}/${p.paradaId}/mover`, { ruta_destino_id: rutaDestinoId });
      const nombreChofer = choferes.find((c) => c.id === choferId)?.nombre ?? 'chofer';
      show('success', 'Parada movida', `Se movió a la ruta de ${nombreChofer}.`);
      queryClient.invalidateQueries({ queryKey: ['rutas', p.rutaId] });
      queryClient.invalidateQueries({ queryKey: ['rutas', rutaDestinoId] });
      recargarListas();
    } catch (err: any) {
      show('error', 'No se pudo mover la parada', err.response?.data?.error || 'Error desconocido');
    }
  }

  /**
   * Handlers de drop reutilizados por las dos variantes de tarjeta de chofer
   * (con y sin ruta armada). Aceptan dos cosas: un pedido de la bolsa
   * (`dragVisita`, lo asigna) o una parada arrastrada desde el detalle de
   * otra ruta (payload 'application/x-mora-parada', la mueve de chofer).
   */
  const propsDropChofer = (choferId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragVisita && !e.dataTransfer.types.includes('application/x-mora-parada')) return;
      e.preventDefault();
      if (dropChofer !== choferId) setDropChofer(choferId);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setDropChofer((c) => (c === choferId ? null : c));
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (dragVisita) {
        e.preventDefault();
        soltarEnChofer(choferId);
        return;
      }
      const raw = e.dataTransfer.getData('application/x-mora-parada');
      if (!raw) return;
      e.preventDefault();
      setDropChofer(null);
      try {
        moverParadaAChofer(JSON.parse(raw), choferId);
      } catch { /* payload inválido: ignorar */ }
    },
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Rutas</h2>
          <p>Planificá el recorrido de cada chofer.</p>
        </div>
      </div>

      {ultimoAutoArmado && (
        <div
          className="autoarmado-aviso"
          // Fijo abajo al centro de la pantalla: sigue a la vista aunque se haga scroll por las rutas.
          style={{ position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: 95, maxWidth: 'calc(100vw - 32px)', display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 10px 10px 14px', background: 'var(--success-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: '0 6px 20px rgba(0,0,0,0.18)', fontSize: '0.84rem' }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <CheckCircle2 size={16} strokeWidth={2} style={{ color: 'var(--success)' }} /> {ultimoAutoArmado.resumen}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={deshacerAutoArmado}>Deshacer</button>
          <button type="button" className="modal-close" onClick={() => setUltimoAutoArmado(null)} title="Cerrar (ya no se podrá deshacer)">
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      )}

      <RoleGate roles={['admin', 'operador']}>
        <div className="form-card">
          <button
            type="button"
            className="btn btn-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            onClick={() => setMostrarFormViaje((v) => !v)}
          >
            <Plus size={15} strokeWidth={2} /> Programar nuevo viaje
            <ChevronDown size={14} strokeWidth={2} style={{ transform: mostrarFormViaje ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
          </button>
          {mostrarFormViaje && (
          <form onSubmit={crearViaje} className="form-row" style={{ marginTop: '14px' }}>
            <div className="form-group">
              <label className="form-label">Tipo</label>
              <select
                className="form-select"
                value={formViaje.tipo}
                onChange={(e) => setFormViaje({ ...formViaje, tipo: e.target.value, ubicacion_id: '' })}
              >
                <option value="entrega">Entrega</option>
                <option value="retiro">Retiro</option>
                <option value="recambio">Recambio</option>
              </select>
            </div>
            {ubicacionesElegiblesViaje.length > 1 && (
              <div className="form-group">
                <label className="form-label">{formViaje.tipo === 'entrega' ? 'Sale de' : 'Se descarga en'}</label>
                <select
                  className="form-select"
                  value={formViaje.ubicacion_id}
                  onChange={(e) => setFormViaje({ ...formViaje, ubicacion_id: e.target.value })}
                >
                  <option value="">— Elegir —</option>
                  {ubicacionesElegiblesViaje.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
                </select>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Fecha</label>
              <input
                type="date"
                className="form-input"
                value={formViaje.fecha}
                onChange={(e) => setFormViaje({ ...formViaje, fecha: e.target.value })}
                required
              />
            </div>
            <div className="form-group">
              <label className="form-label">Horario sugerido</label>
              <select
                className="form-select"
                value={formViaje.horario_preferido}
                onChange={(e) => setFormViaje({ ...formViaje, horario_preferido: e.target.value })}
              >
                <option value="">— Sin preferencia —</option>
                {OPCIONES_HORARIO_SUGERIDO.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Zona</label>
              <select
                className="form-select"
                value={formViaje.zona}
                required={formViaje.tipo === 'recambio'}
                onChange={(e) => setFormViaje({ ...formViaje, zona: e.target.value })}
              >
                <option value="">— Elegir zona —</option>
                {zonasTarifas.map((z) => <option key={z.departamento} value={z.departamento}>{z.departamento}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Dirección de destino</label>
              <input
                className="form-input"
                placeholder="Ej. Av. San Martín 1234, Godoy Cruz"
                value={formViaje.destino_direccion}
                required={formViaje.tipo === 'recambio'}
                onChange={(e) => setFormViaje({ ...formViaje, destino_direccion: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Importe</label>
              <input
                type="number"
                className="form-input"
                placeholder="Ej. 85000"
                value={formViaje.importe}
                required={formViaje.tipo === 'recambio'}
                onChange={(e) => setFormViaje({ ...formViaje, importe: e.target.value })}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={creandoViaje}>
              {creandoViaje ? 'Guardando...' : 'Programar viaje'}
            </button>
          </form>
          )}
        </div>
      </RoleGate>

      {rutasAbiertasAnteriores.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center',
          background: 'var(--warning-bg)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)',
          padding: '10px 14px', marginBottom: '16px', fontSize: '0.82rem',
        }}>
          <AlertTriangle size={16} strokeWidth={2} />
          <span>
            {rutasAbiertasAnteriores.length === 1 ? 'Quedó 1 ruta de un día anterior con paradas pendientes:' : `Quedaron ${rutasAbiertasAnteriores.length} rutas de días anteriores con paradas pendientes:`}
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
        <div className="stat" title="Pedidos sin rutear de este día específico, sobre el total acumulado de todas las fechas">
          <div className="l">Sin asignar (hoy / total)</div>
          <div className={`n${sinAsignarDelDia ? ' warn' : ''}`}>{sinAsignarDelDia} <span style={{ fontSize: '0.5em', fontWeight: 500, color: 'var(--text-muted)' }}>/ {visitasPendientes.length}</span></div>
        </div>
        <div className="stat" title="Rutas con paradas agregadas que todavía no se confirmaron — hasta que se confirmen, el chofer no se entera de ese viaje">
          <div className="l">Rutas sin confirmar</div>
          <div className={`n${rutasSinConfirmar ? ' danger' : ''}`}>{rutasSinConfirmar}</div>
        </div>
        <div className="stat"><div className="l">Choferes activos</div><div className="n">{choferes.length}</div></div>
      </div>

      {/* Layout apilado: Bolsa arriba (a todo el ancho), Choferes y Detalle abajo. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Bolsa de pedidos sin rutear, horizontal (también zona de drop para sacar paradas de una ruta) */}
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', borderBottom: '1px solid var(--border)', paddingBottom: '10px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span>📦 Pedidos sin rutear</span>
              <div className="date-pick" style={{ fontWeight: 500, fontSize: '0.78rem' }}>
                <input type="date" value={fecha} onChange={(e) => {
                  setFecha(e.target.value);
                  setFormViaje((fv) => ({ ...fv, fecha: e.target.value }));
                }} />
              </div>
              <RoleGate roles={['admin', 'operador']}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={autoArmarRutas}
                  disabled={autoArmando}
                  title="Reparte los pedidos de la bolsa entre los choferes (por zona y horario) y los agrega a cada ruta, ordenados. Quedan sin confirmar y se puede deshacer."
                >
                  {autoArmando ? 'Armando rutas…' : '⚡ Auto-armar rutas del día'}
                </button>
              </RoleGate>
            </div>
            <span className="badge programado" style={{ fontSize: '0.75rem' }} title={`Total acumulado sin rutear (todas las fechas): ${visitasPendientes.length}`}>{sinAsignarDelDia}</span>
          </div>

          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
            Mostrando solo los pedidos de este día. Tocá un pedido para ver el detalle. Arrastralo sobre un chofer (abajo) para asignarlo, o arrastrá una parada de una ruta hasta acá para sacarla.
          </div>

          {sinAsignarDelDia === 0 ? (
            <div className="rc-empty" style={{ textAlign: 'center', padding: '20px 0' }}>No hay pedidos pendientes para este día.</div>
          ) : (
            // Se ven ~2 filas de tarjetas; si hay más, scroll vertical acá adentro
            // en vez de alargar toda la página.
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxHeight: '340px', overflowY: 'auto', paddingRight: '4px' }}>
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
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px' }}>
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
                        style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px', padding: '10px 12px', cursor: 'grab', marginBottom: 0 }}
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

                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={(e) => { e.stopPropagation(); cancelarPedidoDeBolsa(visita); }}
                            title="Cancelar pedido y avisarle al cliente por WhatsApp"
                          >
                            <X size={12} strokeWidth={2} /> Cancelar pedido
                          </button>
                        </div>
                      </div>
                    );
                      })}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Choferes y Rutas del Día, abajo de la bolsa, a todo el ancho */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <div className="section-title" style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 0 }}>
                Choferes y Rutas del Día
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={ocultarSinRuta} onChange={(e) => setOcultarSinRuta(e.target.checked)} />
                Ocultar sin ruta
              </label>
            </div>
            <div className="routes-grid">
              {choferes.map((chofer) => {
                const ruta = rutas.find((r) => r.chofer_id === chofer.id);
                if (!ruta) {
                  if (ocultarSinRuta) return null;
                  return (
                    <button
                      key={chofer.id}
                      className={`route-card${dropChofer === chofer.id ? ' drop-activo' : ''}${choferesDestello.has(chofer.id) ? ' destello' : ''}`}
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
                const stats = statsRutas.get(ruta.id) ?? { paradas: 0, ent: 0, ret: 0, rec: 0, warn: 0, sinConfirmar: 0, finalizadas: 0 };
                const estado = badgeRuta(stats);
                const sel = ruta.id === rutaSeleccionada;
                return (
                  <button
                    key={chofer.id}
                    className={`route-card${sel ? ' sel' : ''}${stats.warn ? ' warn' : ''}${dropChofer === chofer.id ? ' drop-activo' : ''}${choferesDestello.has(chofer.id) ? ' destello' : ''}`}
                    onClick={() => setRutaSeleccionada(ruta.id)}
                    {...propsDropChofer(chofer.id)}
                  >
                    <div className="rc-head">
                      <div className="rc-av">{iniciales(chofer.nombre)}</div>
                      <div><div className="rc-nm">{chofer.nombre}</div><div className="rc-pat">{ruta.patente ?? '—'}</div></div>
                      <span className={`badge ${estado.clase}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        {estado.clase === 'sin_confirmar' && <AlertTriangle size={12} strokeWidth={2.5} />}
                        {estado.texto}
                      </span>
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
                pedidoArrastrado={!!dragVisita}
                onInsertarPedido={(orden) => {
                  const v = dragVisita;
                  const choferSel = rutas.find((r) => r.id === rutaSeleccionada)?.chofer_id;
                  setDragVisita(null);
                  setDropChofer(null);
                  setDropDetalle(false);
                  if (v && choferSel) asignarAChofer(v, choferSel, orden);
                }}
              />
            </div>
          ) : (
            <div className="card empty-state" style={{ padding: '40px 20px' }}>
              <div className="empty-state-title">Ninguna ruta seleccionada</div>
              <div className="empty-state-text">Hacé clic en un chofer arriba para ver y armar su ruta, o asignale pedidos directamente desde la bolsa de arriba.</div>
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
