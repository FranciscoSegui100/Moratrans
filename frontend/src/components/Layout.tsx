import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutGrid,
  CreditCard,
  Truck,
  Bell,
  HardHat,
  Package,
  DollarSign,
  FileText,
  ShieldCheck,
  LogOut,
} from 'lucide-react';
import { useAuth, tieneRol, Rol } from '../context/AuthContext';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';
import { useToast } from './Toast';
import { tipoLabel } from '../lib/alertLabels';

interface AlertaSocket { tipo: string; mensaje: string; cliente_telefono?: string | null }

const nav: { to: string; label: string; icon: typeof LayoutGrid; roles?: Rol[] }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutGrid },
  { to: '/pagos', label: 'Validar pagos', icon: CreditCard },
  { to: '/viajes', label: 'Viajes', icon: Truck },
  { to: '/alertas', label: 'Alertas', icon: Bell },
  { to: '/choferes', label: 'Choferes', icon: HardHat },
  { to: '/contenedores', label: 'Contenedores', icon: Package },
  { to: '/tarifas', label: 'Tarifas', icon: DollarSign },
  { to: '/reportes', label: 'Reportes', icon: FileText },
  { to: '/usuarios', label: 'Usuarios', icon: ShieldCheck, roles: ['admin'] },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const { show } = useToast();
  const [alertCount, setAlertCount] = useState(0);
  const navVisible = nav.filter((n) => !n.roles || tieneRol(user, ...n.roles));

  // Conectar socket globalmente y escuchar alertas para el badge + el toast
  useEffect(() => {
    const cargarConteo = () => {
      api.get<{ id: string }[]>('/api/alertas?estado=nueva')
        .then((r) => setAlertCount(r.data.length))
        .catch(() => {});
    };

    const socket = conectarSocket();
    cargarConteo(); // conteo inicial
    // Resincroniza al (re)conectar: si hubo un corte de red o la compu se
    // suspendió, cualquier alerta creada durante ese lapso no llegó por
    // socket y quedaría afuera del contador hasta un refresh manual.
    socket.on('connect', cargarConteo);
    socket.on('nueva_alerta', (a: AlertaSocket) => {
      setAlertCount((c) => c + 1);
      show('info', tipoLabel[a.tipo] ?? a.tipo, a.cliente_telefono ? `${a.cliente_telefono} · ${a.mensaje}` : a.mensaje);
    });
    return () => {
      socket.off('connect', cargarConteo);
      socket.off('nueva_alerta');
    };
  }, []);

  // Al entrar a alertas, resetear el badge
  useEffect(() => {
    if (loc.pathname === '/alertas') setAlertCount(0);
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
            const Icon = n.icon;
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`nav-item ${isActive ? 'active' : ''}`}
              >
                <Icon className="nav-icon" strokeWidth={1.75} />
                {n.label}
                {isAlertas && alertCount > 0 && (
                  <span className="nav-badge">{alertCount > 99 ? '99+' : alertCount}</span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
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

      <main className="main-content">{children}</main>
    </div>
  );
}
