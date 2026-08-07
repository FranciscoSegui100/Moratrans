import { Navigate } from 'react-router-dom';
import { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, cargando } = useAuth();
  // Mientras se resuelve GET /api/auth/me (la sesión vive en una cookie
  // httpOnly, no se puede saber sincrónicamente si existe) no hay que
  // redirigir todavía a /login: se vería un parpadeo en cada recarga.
  if (cargando) return null;
  if (!user) return <Navigate to="/login" replace />;
  // La verificación en dos pasos es opcional (se puede activar desde
  // "Seguridad"), no bloquea el acceso al panel.
  return <>{children}</>;
}
