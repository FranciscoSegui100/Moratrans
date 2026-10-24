import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  LayoutGrid,
  CreditCard,
  Truck,
  Route,
  Bell,
  HardHat,
  Users,
  Package,
  DollarSign,
  ShieldCheck,
  LogOut,
  MessageCircle,
  Receipt,
  TrendingUp,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Sun,
} from 'lucide-react';
import { useAuth, tieneRol, Rol } from '../context/AuthContext';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';
import { useToast } from './Toast';
import { tipoLabel } from '../lib/alertLabels';
import { armarSonidoAlerta, playAlertSound } from '../lib/notificationSound';
import { useTheme } from '../hooks/useTheme';
import { FondoCurvas } from './FondoCurvas';
import { EVENTO_CHAT_LEIDO } from '../hooks/useConversaciones';

interface AlertaSocket { tipo: string; mensaje: string; cliente_telefono?: string | null }
interface ConversacionActualizadaSocket { telefono: string; modo_humano?: boolean }
interface MensajeChatSocket { telefono: string; texto: string; origen: 'cliente' | 'bot' | 'operador' }

type NavItem = { to: string; label: string; icon: typeof LayoutGrid; roles?: Rol[] };

// Sidebar agrupado por área de trabajo (Operación / Recursos / Administración)
// para que la lista no sea un bloque plano de 13 ítems.
const grupos: { titulo: string; items: NavItem[] }[] = [
  {
    titulo: 'Operación',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutGrid },
      { to: '/pagos', label: 'Validar pagos', icon: CreditCard },
      { to: '/comprobantes', label: 'Comprobantes', icon: Receipt },
      { to: '/viajes', label: 'Viajes', icon: Truck },
      { to: '/rutas', label: 'Rutas', icon: Route, roles: ['admin', 'operador'] },
      { to: '/alertas', label: 'Alertas', icon: Bell },
      { to: '/conversaciones', label: 'Conversaciones', icon: MessageCircle },
    ],
  },
  {
    titulo: 'Recursos',
    items: [
      { to: '/choferes', label: 'Choferes', icon: HardHat },
      { to: '/clientes', label: 'Clientes', icon: Users },
      { to: '/contenedores', label: 'Contenedores', icon: Package },
    ],
  },
  {
    titulo: 'Administración',
    items: [
      { to: '/tarifas', label: 'Tarifas', icon: DollarSign },
      { to: '/finanzas', label: 'Finanzas', icon: TrendingUp, roles: ['admin', 'finanzas'] },
      { to: '/usuarios', label: 'Usuarios', icon: ShieldCheck, roles: ['admin'] },
    ],
  },
];

function iniciales(email?: string) {
  if (!email) return '?';
  const base = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  const partes = base.split(/\s+/).filter(Boolean);
  return (partes.length >= 2 ? partes[0][0] + partes[1][0] : base.slice(0, 2)).toUpperCase();
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const { oscuro, toggle: toggleTema } = useTheme();
  const [alertCount, setAlertCount] = useState(0);
  const [conversacionesCount, setConversacionesCount] = useState(0);
  const [pagosCount, setPagosCount] = useState(0);
  const [conectado, setConectado] = useState(true);
  const [menuAbierto, setMenuAbierto] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Qué teléfonos están en modo asesor ahora mismo, para filtrar el aviso
  // global de mensaje nuevo de abajo (ver ese efecto). Ref porque solo lo lee
  // un handler de socket, no hace falta re-renderizar al cambiar.
  const telefonosEnAsesorRef = useRef<Set<string>>(new Set());
  // Chats en modo asesor con mensajes que ESTE usuario no leyó: es lo que
  // cuenta el badge de "Conversaciones" (y el título de la pestaña). Sale de
  // la base (chats_leidos), así que sobrevive a un F5 y a otras pestañas.
  const asesorSinLeerRef = useRef<Set<string>>(new Set());
  // Ruta actual, leída desde handlers de socket/respuestas async (que se
  // registran una sola vez y si no verían siempre la ruta del primer render).
  const pathRef = useRef(loc.pathname);
  pathRef.current = loc.pathname;
  const recargarConteoAlertasRef = useRef<(() => void) | null>(null);
  // Ocultar la barra lateral para que las tablas anchas (Viajes, Contenedores…)
  // usen todo el ancho. Se recuerda por navegador.
  const [sidebarOculta, setSidebarOculta] = useState(() => {
    try { return localStorage.getItem('sidebarOculta') === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem('sidebarOculta', sidebarOculta ? '1' : '0'); } catch { /* modo privado */ }
  }, [sidebarOculta]);

  // Cerrar el menú de usuario al clickear afuera o cambiar de pantalla.
  useEffect(() => {
    if (!menuAbierto) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuAbierto(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuAbierto]);
  useEffect(() => { setMenuAbierto(false); }, [loc.pathname]);

  // Indicador visible de si el socket está conectado, sin depender de que
  // alguien sepa abrir la consola del navegador: si dice "Sin conexión en
  // vivo", ni las alertas ni el resto de las pantallas se van a actualizar
  // solas para esa persona hasta que reconecte (o refresque la página).
  useEffect(() => {
    const socket = conectarSocket();
    const onConnect = () => setConectado(true);
    const onDisconnect = () => setConectado(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);
    setConectado(socket.connected);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onDisconnect);
    };
  }, []);

  // Arma el audio de las alertas con el primer click/tecla del operador en
  // el panel, para que ya esté desbloqueado cuando llegue la primera alerta
  // (los navegadores no dejan sonar audio que no arrancó por un gesto real).
  useEffect(() => armarSonidoAlerta(), []);

  // Conectar socket globalmente y escuchar alertas para el badge + el toast.
  // "Alertas" cuenta TODO lo que va a la bandeja de /alertas (incluidos los
  // pedidos de asesor, que ahora también se listan ahí). "Conversaciones"
  // muestra además, por separado, cuántos de esos son pedidos de asesor. Los
  // pagos pendientes de validar suman a su propio badge en "Validar pagos"
  // además de quedar listados en "Alertas" (no se les saca de ahí).
  //
  // "Alertas" = las que nadie vio todavía (estado 'nueva'). Al entrar a
  // /alertas la propia bandeja las pasa a 'vista' en la base (PATCH
  // /api/alertas/marcar-vistas, ver Alertas.tsx), así que el 0 es real para
  // todos. Mientras se está en /alertas el badge queda en 0 aunque llegue la
  // respuesta de un conteo pedido antes: antes esa respuesta tardía pisaba el
  // 0 con el valor viejo (entrar directo o con F5 a /alertas dejaba "15").
  // "Validar pagos" = pagos pendientes de validar (alertas sin resolver de
  // ese tipo, vistas o no): baja solo al validar/rechazar, no al mirar.
  useEffect(() => {
    const cargarConteo = () => {
      api.get<{ id: string; tipo: string; estado: string }[]>('/api/alertas')
        .then((r) => {
          setAlertCount(pathRef.current === '/alertas' ? 0 : r.data.filter((a) => a.estado === 'nueva').length);
          setPagosCount(r.data.filter((a) => a.tipo === 'pago_pendiente_validacion').length);
        })
        .catch(() => {});
    };
    recargarConteoAlertasRef.current = cargarConteo;

    const socket = conectarSocket();
    cargarConteo(); // conteo inicial
    // Resincroniza al (re)conectar: si hubo un corte de red o la compu se
    // suspendió, cualquier alerta creada durante ese lapso no llegó por
    // socket y quedaría afuera del contador hasta un refresh manual.
    const onNuevaAlerta = (a: AlertaSocket) => {
      if (pathRef.current !== '/alertas') setAlertCount((c) => c + 1);
      if (a.tipo === 'pago_pendiente_validacion') setPagosCount((c) => c + 1);
      show('info', tipoLabel[a.tipo] ?? a.tipo, a.cliente_telefono ? `${a.cliente_telefono} · ${a.mensaje}` : a.mensaje);
      playAlertSound();
    };
    // Otro operador (u otra pestaña) las marcó vistas o resolvió alguna: se
    // vuelve a pedir el conteo real. Con un pequeño retardo porque
    // marcar-vistas emite un evento por alerta y alcanza con un solo request.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAlertaActualizada = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(cargarConteo, 400);
    };
    socket.on('connect', cargarConteo);
    socket.on('nueva_alerta', onNuevaAlerta);
    socket.on('alerta_actualizada', onAlertaActualizada);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off('connect', cargarConteo);
      // Con referencia al handler: useAlertas.ts registra su propio listener
      // de 'nueva_alerta' sobre el mismo socket compartido, y off(evento) sin
      // handler borra TODOS los listeners de ese evento, no solo el propio.
      socket.off('nueva_alerta', onNuevaAlerta);
      socket.off('alerta_actualizada', onAlertaActualizada);
    };
  }, []);

  // Aviso global de "el cliente te sigue escribiendo": una vez que una
  // conversación pasa a modo asesor, los mensajes que manda el cliente
  // DESPUÉS del primer pedido no generan una alerta nueva (son el mismo
  // hilo) — antes, si el operador se iba de Conversaciones a otra pantalla,
  // no había ninguna forma de notar que seguían llegando. Esto escucha
  // 'nuevo_mensaje_chat' (que ya emite el backend por cada mensaje) en
  // cualquier pantalla del panel y avisa solo cuando es del cliente y esa
  // conversación está en modo asesor — si no, sonaría en cada mensaje que
  // contesta el bot solo, para TODAS las conversaciones.
  useEffect(() => {
    const actualizarBadge = () => setConversacionesCount(asesorSinLeerRef.current.size);
    const cargarChats = () => {
      api.get<{ telefono: string; modo_humano: boolean; no_leidos: number }[]>('/api/chat')
        .then((r) => {
          telefonosEnAsesorRef.current = new Set(r.data.filter((c) => c.modo_humano).map((c) => c.telefono));
          asesorSinLeerRef.current = new Set(r.data.filter((c) => c.modo_humano && c.no_leidos > 0).map((c) => c.telefono));
          actualizarBadge();
        })
        .catch(() => {});
    };
    cargarChats();

    const socket = conectarSocket();
    const onConversacionActualizada = (p: ConversacionActualizadaSocket) => {
      // Pasó a modo asesor: se vuelve a pedir la lista para saber si tiene
      // mensajes sin leer (el "asesor" del cliente llega ANTES de este aviso).
      if (p.modo_humano === true) cargarChats();
      else if (p.modo_humano === false) {
        telefonosEnAsesorRef.current.delete(p.telefono);
        asesorSinLeerRef.current.delete(p.telefono);
        actualizarBadge();
      }
    };
    const onNuevoMensajeChat = (m: MensajeChatSocket) => {
      if (m.origen !== 'cliente' || !telefonosEnAsesorRef.current.has(m.telefono)) return;
      asesorSinLeerRef.current.add(m.telefono);
      actualizarBadge();
      show('info', '💬 El cliente te sigue escribiendo', `${m.telefono}: ${m.texto}`);
      playAlertSound();
    };
    // Conversaciones marcó un chat como leído (ver marcarLeido en useConversaciones).
    const onChatLeido = (e: Event) => {
      const telefono = (e as CustomEvent<{ telefono: string }>).detail?.telefono;
      if (telefono && asesorSinLeerRef.current.delete(telefono)) actualizarBadge();
    };
    socket.on('connect', cargarChats);
    socket.on('conversacion_actualizada', onConversacionActualizada);
    socket.on('nuevo_mensaje_chat', onNuevoMensajeChat);
    window.addEventListener(EVENTO_CHAT_LEIDO, onChatLeido);
    return () => {
      socket.off('connect', cargarChats);
      socket.off('conversacion_actualizada', onConversacionActualizada);
      socket.off('nuevo_mensaje_chat', onNuevoMensajeChat);
      window.removeEventListener(EVENTO_CHAT_LEIDO, onChatLeido);
    };
  }, []);

  // Live-refresh genérico para TODAS las pantallas del panel: cuando
  // cualquier operador crea/edita/borra algo bajo /api/<recurso>, el backend
  // avisa acá y esto le dice a React Query "traé de nuevo" — sin esto, cada
  // pantalla solo se actualizaba para quien hizo la acción, y el resto tenía
  // que hacer F5 para verlo (ver backend/src/middleware/broadcastCambios.ts).
  useEffect(() => {
    const socket = conectarSocket();
    const onRecursoActualizado = ({ recurso }: { recurso: string }) => {
      queryClient.invalidateQueries({ queryKey: [recurso] });
      // El dashboard agrega datos de varios recursos (pagos, contenedores,
      // viajes...): se refresca ante cualquier cambio, no solo el suyo.
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      // Recursos cuyo cambio impacta otra pantalla que usa otra queryKey:
      // - validar/rechazar un pago (o marcar efectivo cobrado, o un abono)
      //   mueve los números de Finanzas Y la deuda/cuenta corriente que se ve
      //   en la ficha de un cliente (ClienteDetalle.tsx, queryKey ['clientes',
      //   telefono, ...]) — antes esta pantalla se quedaba con el monto viejo
      //   hasta que alguien la refrescara a mano.
      // - los cambios de /api/chat se listan bajo ['conversaciones']
      // invalidateQueries solo re-consulta lo que está montado, así que si
      // nadie está en esa pantalla es un no-op.
      if (recurso === 'pagos') {
        queryClient.invalidateQueries({ queryKey: ['finanzas'] });
        queryClient.invalidateQueries({ queryKey: ['clientes'] });
      }
      // Si cambian rutas o viajes, invalidar ambos para mantenerlos sincronizados
      if (recurso === 'rutas') queryClient.invalidateQueries({ queryKey: ['viajes'] });
      if (recurso === 'viajes') queryClient.invalidateQueries({ queryKey: ['rutas'] });
    };
    socket.on('recurso_actualizado', onRecursoActualizado);
    return () => { socket.off('recurso_actualizado', onRecursoActualizado); };
  }, [queryClient]);

  // En /alertas el badge es 0 (la bandeja las marca vistas en la base); al
  // salir se vuelve a pedir el conteo real. Conversaciones y Validar pagos
  // ya no se resetean al entrar: bajan cuando de verdad se lee el chat o se
  // valida el pago.
  useEffect(() => {
    if (loc.pathname === '/alertas') setAlertCount(0);
    else recargarConteoAlertasRef.current?.();
  }, [loc.pathname]);

  // Contador en el título de la pestaña: para que un pedido de asesor se
  // note aunque el operador tenga el panel minimizado o en otra pestaña del
  // navegador — el badge del sidebar y el toast ya existen, esto suma
  // visibilidad cuando ni siquiera está mirando la ventana.
  useEffect(() => {
    document.title = conversacionesCount > 0
      ? `(${conversacionesCount}) Moratrans - Panel Logístico`
      : 'Moratrans - Panel Logístico';
  }, [conversacionesCount]);

  return (
    <div className={`layout ${sidebarOculta ? 'sidebar-hidden' : ''}`}>
      <FondoCurvas />
      <button
        className="sidebar-toggle"
        onClick={() => setSidebarOculta((o) => !o)}
        title={sidebarOculta ? 'Mostrar barra lateral' : 'Ocultar barra lateral'}
        aria-label={sidebarOculta ? 'Mostrar barra lateral' : 'Ocultar barra lateral'}
      >
        {sidebarOculta ? <PanelLeftOpen strokeWidth={1.75} /> : <PanelLeftClose strokeWidth={1.75} />}
      </button>
      <aside className="sidebar">
        <div className="sidebar-logo">
          <img src="/logo.png" alt="MoraTrans" className="sidebar-logo-mark" />
          <div>
            <h1>Moratrans</h1>
            <span>Panel logístico</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {grupos.map((grupo) => {
            const items = grupo.items.filter((n) => !n.roles || tieneRol(user, ...n.roles));
            if (items.length === 0) return null;
            return (
              <div key={grupo.titulo} className="nav-group">
                <div className="nav-group-title">{grupo.titulo}</div>
                {items.map((n) => {
                  const isActive = loc.pathname === n.to;
                  const Icon = n.icon;
                  const badge = n.to === '/alertas'
                    ? alertCount
                    : n.to === '/conversaciones'
                      ? conversacionesCount
                      : n.to === '/pagos'
                        ? pagosCount
                        : 0;
                  return (
                    <Link key={n.to} to={n.to} className={`nav-item ${isActive ? 'active' : ''}`}>
                      <Icon className="nav-icon" strokeWidth={1.75} />
                      {n.label}
                      {badge > 0 && <span className="nav-badge">{badge > 99 ? '99+' : badge}</span>}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className={`live-badge ${conectado ? '' : 'offline'}`} style={{ marginLeft: 0, marginBottom: 10 }}>
            <span className="live-dot" />
            {conectado ? 'Conectado en vivo' : 'Sin conexión en vivo'}
          </div>
          <div className="sidebar-user">
            <div className="sidebar-user-email">{user?.email}</div>
            <div className="sidebar-user-role">{user?.rol}</div>
          </div>
          <button onClick={logout} className="btn-logout">
            <LogOut strokeWidth={1.75} />
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Conversaciones usa todo el ancho de la pantalla (lista + hilo + ficha
          del cliente): el tope de 1440px de las demás páginas le sobra. */}
      <main className={`main-content ${loc.pathname.startsWith('/conversaciones') ? 'main-content--ancho' : ''}`}>
        <header className="topbar">
          <div className="topbar-spacer" />
          <div className="topbar-actions">
            <button
              className="topbar-btn"
              onClick={toggleTema}
              title={oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
              aria-label={oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
            >
              {oscuro ? <Sun strokeWidth={1.75} /> : <Moon strokeWidth={1.75} />}
            </button>

            <Link to="/alertas" className="topbar-btn" title="Alertas" aria-label="Alertas">
              <Bell strokeWidth={1.75} />
              {alertCount > 0 && <span className="topbar-btn-badge" />}
            </Link>

            <div className="topbar-user" ref={menuRef}>
              <button
                className="topbar-avatar"
                onClick={() => setMenuAbierto((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuAbierto}
                title={user?.email}
              >
                {iniciales(user?.email)}
              </button>
              {menuAbierto && (
                <div className="topbar-menu" role="menu">
                  <div className="topbar-menu-head">
                    <div className="topbar-menu-email">{user?.email}</div>
                    <div className="topbar-menu-role">{user?.rol}</div>
                  </div>
                  <button className="topbar-menu-item" onClick={logout} role="menuitem">
                    <LogOut size={14} strokeWidth={1.75} />
                    Cerrar sesión
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div key={loc.pathname} className="page-enter">{children}</div>
      </main>
    </div>
  );
}
