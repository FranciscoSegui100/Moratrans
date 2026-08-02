import { createContext, useContext, useState, ReactNode } from 'react';
import { api } from '../api/client';

export type Rol = 'admin' | 'operador' | 'finanzas' | 'lectura';
export interface Usuario {
  id: string;
  email: string;
  rol: Rol;
}

interface AuthCtx {
  user: Usuario | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Usuario | null>(() => {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  });

  async function login(email: string, password: string) {
    const { data } = await api.post('/api/auth/login', { email, password });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
  }

  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    location.href = '/login';
  }

  return <Ctx.Provider value={{ user, login, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/** Helper de UI: ¿el rol actual tiene alguno de estos permisos? */
export function tieneRol(user: Usuario | null, ...roles: Rol[]) {
  return !!user && roles.includes(user.rol);
}
