import { ReactNode } from 'react';
import { useAuth, tieneRol, Rol } from '../context/AuthContext';

// Renderiza children sólo si el rol del usuario está permitido (RBAC en UI).
export function RoleGate({ roles, children }: { roles: Rol[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!tieneRol(user, ...roles)) return null;
  return <>{children}</>;
}
