import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api, intentarRefresh } from '../api/client';

// El access token dura 8h (ver JWT_ACCESS_EXPIRES): con el panel abierto
// horas de corrido, hay que renovarlo antes de que venza para que ni las
// llamadas REST ni el socket (que solo se autentica una vez, al conectar o
// reconectar) se encuentren con una cookie muerta.
const INTERVALO_REFRESH_MS = 10 * 60 * 1000;

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

  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => { intentarRefresh(); }, INTERVALO_REFRESH_MS);
    // El setInterval de arriba no alcanza solo: los navegadores frenan los
    // temporizadores de una pestaña en segundo plano (minimizada, otra
    // pestaña activa, compu suspendida) — si pasan más de 8h así, la
    // cookie vence sin que nadie la renueve. Al volver a esta pestaña,
    // renovamos al toque en vez de esperar al próximo tick del intervalo.
    const alVolver = () => { if (document.visibilityState === 'visible') intentarRefresh(); };
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, [user]);

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
