import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

// withCredentials: la sesión vive en cookies httpOnly (mt_at/mt_rt), no en
// localStorage — el browser las adjunta solo, pero hay que pedírselo.
export const api = axios.create({ baseURL: API_URL, withCredentials: true });

function leerCookie(nombre: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${nombre}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

// Adjunta el token CSRF (doble-cookie) en cada request que muta estado. La
// cookie mt_csrf no es httpOnly a propósito: sólo así este código puede leerla.
api.interceptors.request.use((config) => {
  const metodo = (config.method || 'get').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(metodo)) {
    const csrf = leerCookie('mt_csrf');
    if (csrf) config.headers['X-CSRF-Token'] = csrf;
  }
  return config;
});

// Evita disparar varios refresh en paralelo si varias requests fallan a la vez.
let refrescando: Promise<boolean> | null = null;
export function intentarRefresh(): Promise<boolean> {
  if (!refrescando) {
    refrescando = api.post('/api/auth/refresh')
      .then(() => true)
      .catch(() => false)
      .finally(() => { refrescando = null; });
  }
  return refrescando;
}

// El access token dura 15 min: si expira a mitad de sesión, se intenta
// renovar una vez con el refresh token (cookie aparte) antes de mandar al
// usuario al login.
api.interceptors.response.use(
  (r) => r,
  async (err) => {
    const original = err.config;
    // Solo /refresh queda afuera (evita loop infinito si el refresh token ya
    // no sirve); /me y el resto sí deben poder renovarse solos si el access
    // token venció a mitad de una sesión larga.
    const esRefresh = original?.url?.startsWith('/api/auth/refresh');

    if (err.response?.status === 401 && !esRefresh && !original?._retry) {
      original._retry = true;
      if (await intentarRefresh()) return api(original);
    }

    if (err.response?.status === 401 && location.pathname !== '/login') {
      location.href = '/login';
    }
    return Promise.reject(err);
  },
);

// Descarga un archivo protegido (Excel/PDF) enviando la cookie de sesión y forzando el save.
export async function descargarArchivo(path: string, filename: string) {
  const res = await api.get(path, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
