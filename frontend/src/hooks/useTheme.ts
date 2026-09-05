import { useCallback, useEffect, useState } from 'react';

// Preferencia de tema del panel. 'system' sigue al SO; 'light'/'dark' fuerzan.
// Se persiste en localStorage con la clave 'theme' — el mismo valor que lee el
// script inline de index.html para evitar el flash al cargar.
export type ThemePref = 'light' | 'dark' | 'system';

const KEY = 'theme';

function leerPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* modo privado */ }
  return 'system';
}

function aplicar(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

const mediaOscuro = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(leerPref);
  const [sistemaOscuro, setSistemaOscuro] = useState(() => mediaOscuro()?.matches ?? false);

  useEffect(() => {
    aplicar(pref);
    try { localStorage.setItem(KEY, pref); } catch { /* modo privado */ }
  }, [pref]);

  useEffect(() => {
    const mq = mediaOscuro();
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setSistemaOscuro(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const oscuro = pref === 'dark' || (pref === 'system' && sistemaOscuro);

  // El botón alterna claro/oscuro de forma explícita: una vez que el operador
  // lo toca, deja de seguir al sistema (que es lo esperado de un toggle).
  const toggle = useCallback(() => {
    setPref((p) => {
      const efectivoOscuro = p === 'dark' || (p === 'system' && (mediaOscuro()?.matches ?? false));
      return efectivoOscuro ? 'light' : 'dark';
    });
  }, []);

  return { pref, setPref, oscuro, toggle };
}
