import { CURVAS_LOGIN, RUTA } from '../lib/curvas';

/**
 * Fondo del login: las mismas curvas de nivel del panel, pero en oscuro fijo
 * (no sigue el tema) y con un camión de línea recorriendo "la ruta". El camión
 * se mueve con `offset-path` de CSS y no con `animateMotion` de SVG, para que
 * respete prefers-reduced-motion — ver `.fondo-ruta` en index.css.
 */
export function FondoRuta() {
  return (
    <div className="fondo-ruta">
      <svg viewBox="0 0 680 340" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {/* Capa 1: las curvas de fondo. */}
        <g className="curvas">
          {CURVAS_LOGIN.map((d) => (
            <path key={d} d={d} fill="none" strokeWidth="1" />
          ))}
        </g>

        {/* Capa 2: la ruta, la misma curva otra vez pero apenas más clara. */}
        <path id="ruta" d={RUTA} fill="none" />

        {/* Capa 3: el camión. Dibujado alrededor del origen (0,0) porque ese es
            el punto que `offset-path` apoya sobre la ruta. */}
        <g className="camion">
          <rect x="-17" y="-12" width="21" height="10" rx="1.4" />
          <path d="M5 -2 V-9 h6 l4 4 v3 Z" />
          <circle cx="-11" cy="-1" r="2.4" />
          <circle cx="-1" cy="-1" r="2.4" />
          <circle cx="11" cy="-1" r="2.4" />
        </g>
      </svg>
    </div>
  );
}
