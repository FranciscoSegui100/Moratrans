import { useEffect } from 'react';

/**
 * Escucha la tecla Escape en la ventana global y dispara el callback de cierre
 * cuando `activo` es true. Limpia el event listener al desmontar o desactivar.
 */
export function useEscapeKey(onEscape: () => void, activo: boolean = true) {
  useEffect(() => {
    if (!activo) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onEscape, activo]);
}
