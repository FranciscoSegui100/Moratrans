-- Evita que dos operadores (o el mismo dos veces) creen dos viajes activos
-- del mismo tipo para el mismo contenedor con choferes distintos: sin este
-- índice, POST /api/viajes no tenía ninguna protección contra esa carrera y
-- ambos choferes terminaban viendo el mismo contenedor en su menú de
-- WhatsApp. Se permite que coexistan un viaje de 'entrega' y uno de 'retiro'
-- activos a la vez para el mismo contenedor (así funciona el ciclo real: el
-- viaje de entrega recién se completa cuando se confirma el retiro, ver
-- contenedores.routes.ts /confirmar-retiro).
CREATE UNIQUE INDEX ux_viajes_activo_por_tipo
  ON viajes(contenedor_numero, tipo)
  WHERE estado IN ('programado', 'en_curso') AND contenedor_numero IS NOT NULL;
