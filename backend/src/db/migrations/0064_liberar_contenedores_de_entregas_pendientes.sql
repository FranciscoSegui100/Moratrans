-- Cambio de flujo: el contenedor de una entrega ya no se asigna de antemano
-- (al armar la ruta o validar el pago), lo elige el chofer al entregar. Las
-- entregas que todavía no se hicieron y ya traían un contenedor del flujo
-- viejo se liberan, para arrancar todas con el flujo nuevo:
--   - el contenedor reservado para esa entrega vuelve a 'disponible';
--   - la entrega queda sin contenedor.
-- Un contenedor que todavía está en otro cliente (reserva "a futuro" para
-- cuando vuelva) no se toca: solo se le saca a la entrega.
-- Las entregas ya hechas no se tocan: ese contenedor está en el cliente de
-- verdad. Ojo: completada_en existe desde 0022 y nunca se rellenó para atrás,
-- así que una entrega vieja ya hecha puede figurar sin completada_en — por
-- eso, si su contenedor figura entregado/retirado y no hay otra entrega
-- anterior del mismo contenedor que lo explique, se deja como está.

UPDATE contenedores c
   SET estado = 'disponible', vence_en = NULL, actualizado_por = 'sistema'
 WHERE c.estado = 'reservado'
   AND EXISTS (
     SELECT 1 FROM viajes v
      WHERE v.contenedor_numero = c.numero
        AND v.tipo = 'entrega'
        AND v.estado IN ('programado', 'en_curso')
        AND v.completada_en IS NULL
   );

UPDATE viajes v
   SET contenedor_numero = NULL
 WHERE v.tipo = 'entrega'
   AND v.estado IN ('programado', 'en_curso')
   AND v.completada_en IS NULL
   AND v.contenedor_numero IS NOT NULL
   AND (
     NOT EXISTS (
       SELECT 1 FROM contenedores c
        WHERE c.numero = v.contenedor_numero AND c.estado IN ('entregado', 'retirado')
     )
     OR EXISTS (
       SELECT 1 FROM viajes o
        WHERE o.contenedor_numero = v.contenedor_numero
          AND o.tipo = 'entrega' AND o.id <> v.id AND o.estado <> 'cancelado'
          AND o.creado_en < v.creado_en
     )
   );
