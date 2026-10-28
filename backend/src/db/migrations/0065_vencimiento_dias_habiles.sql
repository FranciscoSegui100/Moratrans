-- Alquiler de 10 días (antes 7, ver DIAS_ALQUILER_ANTES_RETIRO) y ningún
-- vencimiento en sábado o domingo: todos los caminos que cargan vence_en
-- (entrega del chofer, vacío de un recambio, alargues) pasan por acá.
-- Los contenedores que ya están en la calle conservan el vencimiento que
-- se les dio al entregarlos.

-- Vencimiento de un alquiler: `p_base` + `p_dias` días; si cae sábado o
-- domingo (hora Mendoza, UTC-3 fija) se corre al lunes. Nunca vence un fin
-- de semana: no se retira sábado ni domingo.
CREATE OR REPLACE FUNCTION fn_vencimiento_habil(p_base TIMESTAMPTZ, p_dias INT)
RETURNS TIMESTAMPTZ AS $$
DECLARE
  v_vence TIMESTAMPTZ := p_base + make_interval(days => p_dias);
  v_dow   INT := extract(isodow FROM (v_vence - interval '3 hours') AT TIME ZONE 'UTC');
BEGIN
  IF v_dow = 6 THEN RETURN v_vence + interval '2 days'; END IF;
  IF v_dow = 7 THEN RETURN v_vence + interval '1 day'; END IF;
  RETURN v_vence;
END;
$$ LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp;

-- Vencimiento después de un alargue: los días del alargue se suman a los
-- días de alquiler REALES, no al lunes al que se corrió un vencimiento que
-- caía en fin de semana (entregado un miércoles: 10 días = sábado -> lunes;
-- el alargue es sábado + 5 = jueves, no lunes + 5). Si el vencimiento ya no
-- es el original (otro alargue, una fecha cargada a mano) se suma sobre el
-- que hay. Sin vencimiento cargado, desde ahora.
CREATE OR REPLACE FUNCTION fn_vencimiento_alargado(p_numero TEXT, p_dias_alquiler INT, p_dias_alargue INT)
RETURNS TIMESTAMPTZ AS $$
DECLARE
  v_vence   TIMESTAMPTZ;
  v_entrega TIMESTAMPTZ;
  v_base    TIMESTAMPTZ;
BEGIN
  SELECT vence_en INTO v_vence FROM contenedores WHERE numero = p_numero;
  SELECT completada_en INTO v_entrega FROM viajes
   WHERE contenedor_numero = p_numero AND tipo = 'entrega' AND estado <> 'cancelado' AND completada_en IS NOT NULL
   ORDER BY completada_en DESC LIMIT 1;

  v_base := COALESCE(v_vence, now());
  IF v_vence IS NOT NULL AND v_entrega IS NOT NULL
     AND ((v_vence - interval '3 hours') AT TIME ZONE 'UTC')::date
       = ((fn_vencimiento_habil(v_entrega, p_dias_alquiler) - interval '3 hours') AT TIME ZONE 'UTC')::date THEN
    v_base := v_entrega + make_interval(days => p_dias_alquiler);
  END IF;
  RETURN fn_vencimiento_habil(v_base, p_dias_alargue);
END;
$$ LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp;
