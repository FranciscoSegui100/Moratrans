import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth, tieneRol, Rol } from '../context/AuthContext';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';

const nav: { to: string; label: string; icon: string; roles?: Rol[] }[] = [
  { to: '/', label: 'Dashboard', icon: '📊' },
  { to: '/pagos', label: 'Validar pagos', icon: '💳' },
  { to: '/viajes', label: 'Viajes', icon: '🚛' },
  { to: '/alertas', label: 'Alertas', icon: '🔔' },
  { to: '/choferes', label: 'Choferes', icon: '👷' },
  { to: '/contenedores', label: 'Contenedores', icon: '📦' },
  { to: '/tarifas', label: 'Tarifas', icon: '💵' },
  { to: '/reportes', label: 'Reportes', icon: '📄' },
  { to: '/usuarios', label: 'Usuarios', icon: '🔐', roles: ['admin'] },
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
          <h1>🚚 LogiPanel</h1>
          <span>Sistema logístico</span>
        </div>

        <nav className="sidebar-nav">
          {navVisible.map((n) => {
            const isActive = loc.pathname === n.to;
            const isAlertas = n.to === '/alertas';
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`nav-item ${isActive ? 'active' : ''}`}
              >
                <span className="nav-icon">{n.icon}</span>
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
          <button onClick={logout} className="btn-logout">Cerrar sesión</button>
        </div>
      </aside>

      <main className="main-content">{children}</main>
    </div>
  );
}
