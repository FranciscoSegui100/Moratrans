import { CURVAS } from '../lib/curvas';

/**
 * Fondo del panel: curvas de nivel estáticas con una luz azul que las recorre
 * de izquierda a derecha. Decorativo (aria-hidden) y detrás de todo el
 * contenido — ver `.fondo-curvas` en index.css para los colores por tema y la
 * animación, que es solo `transform` sobre la banda de la máscara.
 */
export function FondoCurvas() {
  return (
    <div className="fondo-curvas">
      <svg viewBox="0 0 680 340" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          {/* Degradé negro→blanco→negro: en una máscara, blanco muestra y
              negro oculta, así que recorta una banda de luz con bordes
              difusos sobre las curvas duplicadas de abajo. */}
          <linearGradient id="sg" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#000" />
            <stop offset="0.42" stopColor="#fff" />
            <stop offset="0.58" stopColor="#fff" />
            <stop offset="1" stopColor="#000" />
          </linearGradient>
          <mask id="sm">
            <rect className="banda" x="-260" y="-40" width="220" height="420" fill="url(#sg)" />
          </mask>
        </defs>

        {/* Capa 1: las curvas, siempre visibles. */}
        <g className="curvas">
          {CURVAS.map((d) => (
            <path key={d} d={d} fill="none" strokeWidth="1" />
          ))}
        </g>

        {/* Capa 2: las mismas curvas en azul, visibles solo donde pasa la banda. */}
        <g className="curvas-luz" mask="url(#sm)">
          {CURVAS.map((d) => (
            <path key={d} d={d} fill="none" />
          ))}
        </g>
      </svg>
    </div>
  );
}
