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

interface AlertaSocket { tipo: string; mensaje: string; cliente_telefono?: string | null }

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
  useEffect(() => {
    const cargarConteo = () => {
      api.get<{ id: string; tipo: string }[]>('/api/alertas?estado=nueva')
        .then((r) => {
          setAlertCount(r.data.length);
          setConversacionesCount(r.data.filter((a) => a.tipo === 'solicita_asesor').length);
          setPagosCount(r.data.filter((a) => a.tipo === 'pago_pendiente_validacion').length);
        })
        .catch(() => {});
    };

    const socket = conectarSocket();
    cargarConteo(); // conteo inicial
    // Resincroniza al (re)conectar: si hubo un corte de red o la compu se
    // suspendió, cualquier alerta creada durante ese lapso no llegó por
    // socket y quedaría afuera del contador hasta un refresh manual.
    const onNuevaAlerta = (a: AlertaSocket) => {
      setAlertCount((c) => c + 1);
      if (a.tipo === 'solicita_asesor') setConversacionesCount((c) => c + 1);
      if (a.tipo === 'pago_pendiente_validacion') setPagosCount((c) => c + 1);
      show('info', tipoLabel[a.tipo] ?? a.tipo, a.cliente_telefono ? `${a.cliente_telefono} · ${a.mensaje}` : a.mensaje);
      playAlertSound();
    };
    socket.on('connect', cargarConteo);
    socket.on('nueva_alerta', onNuevaAlerta);
    return () => {
      socket.off('connect', cargarConteo);
      // Con referencia al handler: useAlertas.ts registra su propio listener
      // de 'nueva_alerta' sobre el mismo socket compartido, y off(evento) sin
      // handler borra TODOS los listeners de ese evento, no solo el propio.
      socket.off('nueva_alerta', onNuevaAlerta);
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
      // - validar/rechazar un pago mueve los números de Finanzas
      // - los cambios de /api/chat se listan bajo ['conversaciones']
      // invalidateQueries solo re-consulta lo que está montado, así que si
      // nadie está en esa pantalla es un no-op.
      if (recurso === 'pagos') queryClient.invalidateQueries({ queryKey: ['finanzas'] });
      if (recurso === 'chat') queryClient.invalidateQueries({ queryKey: ['conversaciones'] });
    };
    socket.on('recurso_actualizado', onRecursoActualizado);
    return () => { socket.off('recurso_actualizado', onRecursoActualizado); };
  }, [queryClient]);

  // Al entrar a cada sección, resetear su badge
  useEffect(() => {
    if (loc.pathname === '/alertas') setAlertCount(0);
    if (loc.pathname === '/conversaciones') setConversacionesCount(0);
    if (loc.pathname === '/pagos') setPagosCount(0);
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

      <main className="main-content">
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
