-- Corrige contenedores.vence_en para los contenedores que quedaron
-- 'reservado' ANTES de que se arreglara reservarParaEntrega() (ver
-- contenedorReserva.service.ts): esa función seteaba vence_en = fecha de
-- entrega pelada, sin sumarle los DIAS_ALQUILER_ANTES_RETIRO (7) — el bug ya
-- se corrigió en el código, pero los contenedores que se reservaron antes se
-- quedaron con el valor viejo hasta que alguien los entregue de verdad (recién
-- ahí chofer.flow.ts los pisa con la fecha real + 7). Esta migración corre
-- una sola vez y adelanta esa corrección para no dejarlos mostrando mal en el
-- panel mientras tanto.
--
-- Se recalcula desde el viaje de entrega vigente de cada contenedor (mismo
-- dato que reservarParaEntrega ya usa como fuente), a medianoche Argentina
-- (03:00:00 UTC) — igual que medianocheArgentina() en TypeScript.
UPDATE contenedores c
   SET vence_en = ((v.fecha + 7)::text || 'T03:00:00.000Z')::timestamptz
  FROM (
    SELECT DISTINCT ON (contenedor_numero) contenedor_numero, fecha
      FROM viajes
     WHERE tipo = 'entrega' AND estado IN ('programado', 'en_curso') AND contenedor_numero IS NOT NULL
     ORDER BY contenedor_numero, creado_en DESC
  ) v
 WHERE c.numero = v.contenedor_numero
   AND c.estado = 'reservado';
