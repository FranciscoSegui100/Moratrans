-- Hasta ahora una parada de vaciado era un cartel sin ningún link a un
-- contenedor real: no decía cuál se iba a vaciar ni reflejaba si ya estaba
-- lleno o vacío de verdad (eso solo lo sabía el chofer por WhatsApp, un
-- circuito aparte que no se enteraba de las rutas del panel). Sumamos el
-- link al contenedor para que el panel pueda mostrar su estado real y
-- ofrecer la misma acción de "ya se vació" que ya usa el chofer.
ALTER TABLE ruta_vaciados ADD COLUMN IF NOT EXISTS contenedor_numero TEXT
  REFERENCES contenedores(numero) ON DELETE SET NULL;
