import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '../api/client';

export type Rol = 'admin' | 'operador' | 'finanzas' | 'lectura';
export interface Usuario {
  id: string;
  email: string;
  rol: Rol;
  mfaEnabled: boolean;
  mfaMetodo: 'totp' | 'email' | null;
}

type ResultadoLogin = { mfaRequired: true; challengeId: string; metodo: 'totp' | 'email' } | { mfaRequired: false };

interface AuthCtx {
  user: Usuario | null;
  cargando: boolean;
  login: (email: string, password: string, recordar?: boolean) => Promise<ResultadoLogin>;
  verificarMfa: (challengeId: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Para flujos que ya loguean al usuario del lado del backend (aceptar invitación, reset de contraseña, MFA) y solo necesitan reflejarlo acá. */
  establecerUsuario: (u: Usuario) => void;
}

const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Usuario | null>(null);
  // La sesión vive en una cookie httpOnly que JS no puede leer: al cargar la
  // app hay que preguntarle al backend si hay una válida.
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    api.get('/api/auth/me')
      .then(({ data }) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setCargando(false));
  }, []);

  async function login(email: string, password: string, recordar = false): Promise<ResultadoLogin> {
    const { data } = await api.post('/api/auth/login', { email, password, recordar });
    if (data.mfaRequired) return { mfaRequired: true, challengeId: data.challengeId, metodo: data.metodo };
    setUser(data.user);
    return { mfaRequired: false };
  }

  async function verificarMfa(challengeId: string, code: string) {
    const { data } = await api.post('/api/auth/mfa/verify', { challengeId, code });
    setUser(data.user);
  }

  async function logout() {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setUser(null);
      location.href = '/login';
    }
  }

  return (
    <Ctx.Provider value={{ user, cargando, login, verificarMfa, logout, establecerUsuario: setUser }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);

/** Helper de UI: ¿el rol actual tiene alguno de estos permisos? */
export function tieneRol(user: Usuario | null, ...roles: Rol[]) {
  return !!user && roles.includes(user.rol);
}
