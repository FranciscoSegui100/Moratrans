// Las curvas de nivel (topográficas) del fondo. El mismo trazado se usa en el
// panel (FondoCurvas) y en el login (FondoRuta) a propósito: las dos pantallas
// son dos estados de una misma imagen, así que las curvas viven acá una sola
// vez y no se duplican en cada componente.
// Coordenadas en el espacio del viewBox "0 0 680 340".
export const CURVAS = [
  'M-30 310 C 84 276, 184 330, 292 292 S 516 238, 710 274',
  'M-30 280 C 90 240, 190 300, 300 258 S 520 198, 710 240',
  'M-30 250 C 96 206, 200 272, 310 226 S 526 162, 710 208',
  'M-30 220 C 102 172, 210 244, 320 194 S 532 126, 710 176',
  'M-30 190 C 108 138, 220 216, 330 162 S 538 90, 710 144',
  'M-30 160 C 114 104, 230 188, 340 130 S 544 54, 710 112',
  'M-30 130 C 120 70, 240 160, 350 98 S 550 18, 710 80',
  'M-30 100 C 126 36, 250 132, 360 66 S 556 -18, 710 48',
];

// "La ruta": la segunda curva, la única que el login dibuja aparte (más clara)
// y por la que viaja el camión. El `offset-path` del camión repite este mismo
// trazado en index.css — CSS no puede leer una variable acá, así que si se
// toca esta curva hay que tocar también el `offset-path` de `.camion`.
export const RUTA = CURVAS[1];

// El login usa 7: omite la primera (y=310) porque pasa demasiado cerca del
// borde inferior y choca visualmente con la tarjeta centrada.
export const CURVAS_LOGIN = CURVAS.slice(1);
