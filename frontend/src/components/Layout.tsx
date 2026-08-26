import { ReactNode, useEffect, useState } from 'react';
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
  Volume2,
} from 'lucide-react';
import { useAuth, tieneRol, Rol } from '../context/AuthContext';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';
import { useToast } from './Toast';
import { tipoLabel } from '../lib/alertLabels';
import { armarSonidoAlerta, playAlertSound } from '../lib/notificationSound';

interface AlertaSocket { tipo: string; mensaje: string; cliente_telefono?: string | null }

const nav: { to: string; label: string; icon: typeof LayoutGrid; roles?: Rol[] }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutGrid },
  { to: '/pagos', label: 'Validar pagos', icon: CreditCard },
  { to: '/viajes', label: 'Viajes', icon: Truck },
  { to: '/rutas', label: 'Rutas', icon: Route, roles: ['admin', 'operador'] },
  { to: '/alertas', label: 'Alertas', icon: Bell },
  { to: '/conversaciones', label: 'Conversaciones', icon: MessageCircle },
  { to: '/choferes', label: 'Choferes', icon: HardHat },
  { to: '/clientes', label: 'Clientes', icon: Users },
  { to: '/contenedores', label: 'Contenedores', icon: Package },
  { to: '/tarifas', label: 'Tarifas', icon: DollarSign },
  { to: '/usuarios', label: 'Usuarios', icon: ShieldCheck, roles: ['admin'] },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [alertCount, setAlertCount] = useState(0);
  const [conversacionesCount, setConversacionesCount] = useState(0);
  const [pagosCount, setPagosCount] = useState(0);
  const [conectado, setConectado] = useState(true);
  const navVisible = nav.filter((n) => !n.roles || tieneRol(user, ...n.roles));

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
  // "Conversaciones" muestra la cantidad de clientes que pidieron asesor
  // (tipo 'solicita_asesor'), separado del badge de "Alertas". Los pagos
  // pendientes de validar suman a su propio badge en "Validar pagos" además
  // de quedar listados en "Alertas" (no se les saca de ahí).
  useEffect(() => {
    const cargarConteo = () => {
      api.get<{ id: string; tipo: string }[]>('/api/alertas?estado=nueva')
        .then((r) => {
          setAlertCount(r.data.filter((a) => a.tipo !== 'solicita_asesor').length);
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
      if (a.tipo === 'solicita_asesor') setConversacionesCount((c) => c + 1);
      else setAlertCount((c) => c + 1);
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

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-mark">MT</div>
          <div>
            <h1>Moratrans</h1>
            <span>Panel logístico</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navVisible.map((n) => {
            const isActive = loc.pathname === n.to;
            const isAlertas = n.to === '/alertas';
            const isConversaciones = n.to === '/conversaciones';
            const isPagos = n.to === '/pagos';
            const Icon = n.icon;
            const badge = isAlertas ? alertCount : isConversaciones ? conversacionesCount : isPagos ? pagosCount : 0;
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`nav-item ${isActive ? 'active' : ''}`}
              >
                <Icon className="nav-icon" strokeWidth={1.75} />
                {n.label}
                {badge > 0 && (
                  <span className="nav-badge">{badge > 99 ? '99+' : badge}</span>
                )}
              </Link>
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
          <button onClick={playAlertSound} className="btn-sidebar-action">
            <Volume2 strokeWidth={1.75} />
            Probar sonido
          </button>
          <button onClick={logout} className="btn-logout">
            <LogOut strokeWidth={1.75} />
            Cerrar sesión
          </button>
        </div>
      </aside>

      <main className="main-content">{children}</main>
    </div>
  );
}
