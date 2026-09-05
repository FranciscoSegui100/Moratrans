-- "Ruta viva": la ruta ya no tiene ciclo de vida. Siempre está abierta y
-- acepta trabajo nuevo todo el día. Lo que antes se leía de `rutas.estado`
-- (¿está abierta?, ¿hay que confirmar?, ¿ya terminó?) ahora se deriva de las
-- paradas (`viajes.ruta_confirmada_en` / `viajes.completada_en`).
--
-- Se elimina también la posibilidad de "cancelar" una ruta: si se cae un
-- camión, las paradas se mueven a otro chofer (POST /rutas/:id/paradas/.../mover)
-- o se borra la ruta si todavía no confirmó nada.

-- 1. Limpiar las rutas canceladas que existan: sus paradas vuelven a la bolsa
--    (ruta_id/orden/chofer NULL, respetando chk_viajes_ruta_orden) y la ruta se
--    borra. Hace falta ANTES de recrear el índice único sin el filtro
--    `estado <> 'cancelada'`: si quedara una ruta cancelada junto a una activa
--    del mismo chofer+fecha, el índice nuevo fallaría.
UPDATE viajes SET ruta_id = NULL, orden = NULL, chofer_id = NULL, patente = NULL
 WHERE ruta_id IN (SELECT id FROM rutas WHERE estado = 'cancelada');
DELETE FROM rutas WHERE estado = 'cancelada';  -- ruta_vaciados cae por ON DELETE CASCADE

-- 2. Sacar el estado.
DROP INDEX IF EXISTS ux_rutas_chofer_fecha;
DROP INDEX IF EXISTS idx_rutas_estado;
ALTER TABLE rutas DROP COLUMN estado;
DROP TYPE IF EXISTS estado_ruta;

-- 3. Una sola ruta por chofer por día (antes el índice excluía las canceladas).
CREATE UNIQUE INDEX ux_rutas_chofer_fecha ON rutas(chofer_id, fecha);
