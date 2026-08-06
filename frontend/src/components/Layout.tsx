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
  const [alertCount, setAlertCount] = useState(0);
  const navVisible = nav.filter((n) => !n.roles || tieneRol(user, ...n.roles));

  // Conectar socket globalmente y escuchar alertas para el badge
  useEffect(() => {
    // Cargar conteo inicial de alertas abiertas
    api.get<{ id: string }[]>('/api/alertas?estado=nueva')
      .then((r) => setAlertCount(r.data.length))
      .catch(() => {});

    // Escuchar nuevas alertas en tiempo real
    const socket = conectarSocket();
    socket.on('nueva_alerta', () => {
      setAlertCount((c) => c + 1);
    });
    return () => { socket.off('nueva_alerta'); };
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
