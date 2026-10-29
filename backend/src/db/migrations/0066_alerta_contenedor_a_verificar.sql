-- El chofer escribe a mano qué contenedor dejó (ver chofer.flow.ts). Si el
-- número no existe o no está disponible, la entrega se registra igual (no se
-- traba al chofer en la calle) y la oficina asigna el correcto desde el
-- panel: esta alerta no se puede cerrar hasta que lo haga.
ALTER TYPE tipo_alerta ADD VALUE IF NOT EXISTS 'contenedor_a_verificar';
