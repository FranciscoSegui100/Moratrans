-- Pagos que cargó un operador a mano desde el panel (viaje manual, alargue,
-- recambio). Uno en efectivo todavía sin cobrar NO va a "Validar pagos": lo
-- confirma el chofer al entregar ("¿Cobraste?") o el asesor desde la ficha
-- del cliente. Validarlo ahí le mandaba al cliente "ya recibimos tu pago" y,
-- en un alargue, volvía a sumar los días.
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS cargado_en_panel BOOLEAN NOT NULL DEFAULT FALSE;

-- Los que ya existen: atados a un viaje cargado desde el panel, o alargues
-- que no pidió el cliente por WhatsApp (esos levantan 'alargue_solicitado').
UPDATE pagos p SET cargado_en_panel = TRUE
 WHERE EXISTS (SELECT 1 FROM viajes v WHERE v.pago_id = p.id AND v.canal = 'panel')
    OR (p.tipo = 'alargue_retiro' AND NOT EXISTS (
          SELECT 1 FROM alertas a WHERE a.tipo = 'alargue_solicitado' AND a.referencia_id = p.id::text));
