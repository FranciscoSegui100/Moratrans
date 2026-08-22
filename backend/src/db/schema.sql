-- =====================================================================
--  SISTEMA DE GESTIÓN LOGÍSTICA + CHATBOT WHATSAPP
--  Esquema PostgreSQL — Única fuente de verdad
--  Convención: snake_case, UTC, soft-references por teléfono en flujos de chat.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- 1. TIPOS / ENUMS (máquinas de estado)
-- ---------------------------------------------------------------------

-- Estados logísticos del contenedor.
-- Transiciones válidas se fuerzan por trigger (ver fn_validar_transicion_contenedor).
CREATE TYPE estado_contenedor AS ENUM (
  'disponible',      -- en depósito, libre
  'reservado',       -- pago validado, asignado a un ticket
  'entregado',       -- entregado al cliente        (modificable por chofer)
  'retirado',        -- retirado/devuelto vacío     (modificable por chofer)
  'mantenimiento'    -- fuera de servicio
);

CREATE TYPE estado_pedido AS ENUM (
  'nuevo', 'cotizado', 'confirmado', 'en_proceso', 'completado', 'cancelado'
);

CREATE TYPE estado_pago AS ENUM (
  'pendiente',   -- comprobante recibido, esperando validación manual
  'validado',    -- operador confirmó -> dispara creación de ticket + reserva
  'rechazado'
);

CREATE TYPE estado_alerta AS ENUM ('nueva', 'vista', 'resuelta');

-- Ciclo de vida del ticket (sección 21 del documento maestro).
CREATE TYPE estado_ticket AS ENUM ('activo', 'cerrado');

-- Viajes programados de entrega/retiro (secciones 13 y 15.2).
CREATE TYPE tipo_viaje   AS ENUM ('entrega', 'retiro');
CREATE TYPE estado_viaje AS ENUM ('programado', 'en_curso', 'completado', 'cancelado');

CREATE TYPE tipo_alerta AS ENUM (
  'contenedor_por_vencer',
  'pago_vencido',
  'pago_pendiente_validacion',
  'chofer_no_reconocido',
  'chofer_cambio_telefono',
  'stock_bajo',
  'solicita_asesor',
  'confirmar_retiro',
  'factura_solicitada',
  'envio_fallido',
  'cuenta_corriente_solicitada',
  'recambio_solicitado',
  'retiro_solicitado',
  'entrega_solicitada',
  'alargue_solicitado'
);

-- 'flete' = pago normal (ligado a un pedido). 'alargue_retiro' = paga el 50%
-- de su último pago validado para sumar 5 días al vencimiento de un
-- contenedor que ya tiene — no crea ticket ni reserva nada (ver
-- alargarRetiro.flow.ts y POST /api/pagos/:id/validar).
CREATE TYPE tipo_pago AS ENUM ('flete', 'alargue_retiro');

-- Cuenta corriente: clientes que pagan a fin de mes o cuando se juntan
-- varios retiros, en vez de transferir antes de cada uno (ver pago.flow.ts).
CREATE TYPE estado_cuenta_corriente AS ENUM ('sin_pedir', 'pendiente', 'aprobada', 'rechazada');

-- Roles del panel (RBAC). Ver middleware/rbac.ts
CREATE TYPE rol_usuario AS ENUM ('admin', 'operador', 'finanzas', 'lectura');

-- Ubicaciones propias de la empresa: depósitos (de donde salen los vacíos
-- para una entrega) y vaciaderos (adonde se lleva un lleno a vaciar en un
-- retiro). Puede haber varias de cada tipo — no es una dirección fija.
CREATE TYPE tipo_ubicacion AS ENUM ('deposito', 'vaciadero');

-- Pestaña "Ruta": pre-planificación del recorrido diario de un chofer.
CREATE TYPE estado_ruta AS ENUM ('planificada', 'en_curso', 'finalizada', 'cancelada');

-- ---------------------------------------------------------------------
-- 2. USUARIOS DEL PANEL (RBAC)
-- ---------------------------------------------------------------------
CREATE TABLE usuarios (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,          -- bcrypt/argon2, nunca en claro
  rol           rol_usuario NOT NULL DEFAULT 'lectura',
  activo        BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Se incrementa al desactivar, cambiar rol o resetear contraseña: invalida
  -- al instante cualquier JWT ya emitido (ver middleware/rbac.ts).
  token_version INTEGER     NOT NULL DEFAULT 0,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- --- Autenticación reforzada (MFA, SMS, Google, fuerza bruta) ---
  mfa_secret_enc   TEXT,                       -- secreto TOTP cifrado (AES-256-GCM, ver crypto.service.ts)
  mfa_enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  mfa_backup_codes TEXT[]      NOT NULL DEFAULT '{}', -- códigos de un solo uso, hasheados (bcrypt)
  telefono         TEXT,                       -- E.164, para 2FA por SMS
  google_sub       TEXT UNIQUE,                -- id estable de Google, vincula la cuenta al loguear con Google
  failed_attempts  INTEGER     NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  ultima_conexion  TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- 3. CLIENTES / CHOFERES
-- ---------------------------------------------------------------------
CREATE TABLE clientes (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre    TEXT NOT NULL,
  telefono  TEXT NOT NULL UNIQUE,             -- E.164, clave natural en chat
  direccion TEXT,
  -- Se pide desde el bot (ver pago.flow.ts); 'aprobada' la deja poner un
  -- operador tras la primera validación manual de un pago con este flag.
  cuenta_corriente_estado estado_cuenta_corriente NOT NULL DEFAULT 'sin_pedir',
  -- Numeración interna propia del cliente (viene de la planilla Excel que
  -- ya usaban antes del sistema, ver excelClientes() en reportes.service.ts).
  numero_plan INTEGER,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX clientes_numero_plan_key ON clientes(numero_plan) WHERE numero_plan IS NOT NULL;

CREATE TABLE choferes (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre    TEXT    NOT NULL,
  -- DNI cifrado en reposo (AES-256-GCM en la app). El texto plano nunca toca la DB.
  -- NULL = anonimizado (retención: 365 días desde desactivado_en, ver limpieza.cron.ts).
  dni_enc   TEXT,                              -- ciphertext base64 (iv:tag:data)
  -- Blind index (HMAC determinístico) para poder buscar por DNI sin descifrar.
  dni_hash  TEXT    UNIQUE,
  telefono  TEXT,                             -- se usa para autoidentificar en WA; NULL = desvinculado
  -- Patente del camión que maneja habitualmente. No es UNIQUE: un camión puede
  -- rotar entre choferes en distintos turnos/períodos.
  patente   TEXT,
  activo    BOOLEAN NOT NULL DEFAULT TRUE,
  -- Desde cuándo activo=false; usado para contar los 365 días de retención del DNI.
  desactivado_en TIMESTAMPTZ,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Único cuando hay teléfono: dos choferes desvinculados (NULL) no chocan entre sí.
CREATE UNIQUE INDEX choferes_telefono_key ON choferes(telefono) WHERE telefono IS NOT NULL;

-- ---------------------------------------------------------------------
-- 4. TARIFAS (consultadas por el bot, NUNCA hardcodeadas)
-- ---------------------------------------------------------------------
CREATE TABLE tarifas_departamento (
  departamento  TEXT           PRIMARY KEY,   -- ej. 'Montevideo', 'Canelones'
  precio        NUMERIC(12,2)  NOT NULL CHECK (precio >= 0),
  moneda        TEXT           NOT NULL DEFAULT 'ARS',
  activo        BOOLEAN        NOT NULL DEFAULT TRUE,
  actualizado_en TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- Anillo exterior [[lng,lat], ...] del límite administrativo, usado por
  -- geoDepartamento.service.ts para detectar cuando la ubicación que
  -- comparte el cliente no coincide con el departamento que cotizó (ver
  -- migración 0025). NULL = sin polígono cargado, no se valida ese depto.
  limite_geografico JSONB
);

-- ---------------------------------------------------------------------
-- 5. CONTENEDORES + HISTORIAL
-- ---------------------------------------------------------------------
CREATE TABLE contenedores (
  numero        TEXT PRIMARY KEY,             -- ej. 'MSKU1234567'
  estado        estado_contenedor NOT NULL DEFAULT 'disponible',
  cliente_id    UUID REFERENCES clientes(id) ON DELETE SET NULL,
  vence_en      TIMESTAMPTZ,                  -- usado por el cron de alertas
  actualizado_por TEXT,                       -- usuario/chofer/sistema
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_contenedores_estado ON contenedores(estado);
CREATE INDEX idx_contenedores_vence  ON contenedores(vence_en);

CREATE TABLE historial_contenedores (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_contenedor TEXT NOT NULL REFERENCES contenedores(numero) ON DELETE CASCADE,
  estado            estado_contenedor NOT NULL,
  chofer_id         UUID REFERENCES choferes(id) ON DELETE SET NULL,
  nota              TEXT,
  actualizado_por   TEXT,                       -- mismo formato "chofer:<uuid>"/"operador:<uuid>" que contenedores.actualizado_por
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hist_contenedor ON historial_contenedores(numero_contenedor);

-- ---------------------------------------------------------------------
-- 6. PEDIDOS / PAGOS / TICKETS
-- ---------------------------------------------------------------------
CREATE TABLE pedidos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_telefono TEXT          NOT NULL,
  cliente_nombre   TEXT,                        -- nombre de perfil de WhatsApp del cliente (contacts[].profile.name)
  zona             TEXT          NOT NULL,     -- departamento cotizado
  precio           NUMERIC(12,2),             -- congelado al momento de cotizar
  fecha_aproximada DATE,
  destino_lat      NUMERIC(9,6),               -- ubicación GPS compartida por WhatsApp (si aplica)
  destino_lng      NUMERIC(9,6),
  destino_direccion TEXT,                      -- dirección escrita por el cliente, o la que venga con la ubicación GPS
  -- Franja horaria elegida por el cliente (botones de horarioPreferido.flow.ts,
  -- ej. "🌅 Mañana (8 a 12hs)") — no confundir con viajes.hora_estimada, que
  -- es el compromiso que arma el operador, no lo que pidió el cliente.
  horario_preferido TEXT,
  estado           estado_pedido NOT NULL DEFAULT 'nuevo',
  -- 'recambio': se cotiza y se cobra igual que una entrega, pero al validar
  -- el pago se crea el par retiro(lleno)+entrega(vacío) en vez de una sola
  -- entrega (ver contenedor_recambio_numero y pagos.routes.ts /validar).
  tipo             TEXT NOT NULL DEFAULT 'entrega' CHECK (tipo IN ('entrega', 'recambio')),
  -- Solo si tipo = 'recambio': el contenedor lleno que ya se sabe que hay que
  -- retirar (viene de contenedoresDelCliente, no se le vuelve a preguntar).
  contenedor_recambio_numero TEXT REFERENCES contenedores(numero) ON DELETE SET NULL,
  creado_en        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_pedidos_telefono ON pedidos(cliente_telefono);
CREATE INDEX idx_pedidos_estado   ON pedidos(estado);

CREATE TABLE pagos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_telefono TEXT        NOT NULL,
  pedido_id        UUID REFERENCES pedidos(id) ON DELETE SET NULL,
  monto            NUMERIC(12,2),
  url_comprobante  TEXT,                        -- ruta/URL del media descargado de Meta
  media_id         TEXT,                        -- id original del media en Graph API
  factura_url      TEXT,                        -- ruta cifrada de la factura cargada por un operador
  titular_transferencia TEXT,                   -- a nombre de quién hizo la transferencia (lo pide el bot, ver pago.flow.ts)
  -- El cliente eligió pagar contra su cuenta corriente en vez de transferir:
  -- no tiene url_comprobante, pero igual pasa por la misma validación manual
  -- (fn_validar_pago) antes de reservar contenedor y crear el ticket.
  es_cuenta_corriente BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'flete' (default) o 'alargue_retiro' — ver comentario de tipo_pago arriba.
  tipo             tipo_pago   NOT NULL DEFAULT 'flete',
  -- Solo se usa cuando tipo = 'alargue_retiro': qué contenedor extender.
  contenedor_numero TEXT REFERENCES contenedores(numero) ON DELETE SET NULL,
  estado           estado_pago NOT NULL DEFAULT 'pendiente',
  validado_por     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_rechazo   TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pagos_estado   ON pagos(estado);
CREATE INDEX idx_pagos_telefono ON pagos(cliente_telefono);

-- Comprobantes adicionales de un pago que ya está pendiente de validar (ej.
-- llega un segundo comprobante para la misma cotización): se cuelgan acá en
-- vez de crear un pago/alerta duplicados (ver pago.flow.ts).
CREATE TABLE pagos_adjuntos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pago_id         UUID NOT NULL REFERENCES pagos(id) ON DELETE CASCADE,
  url_comprobante TEXT NOT NULL,
  media_id        TEXT,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pagos_adjuntos_pago ON pagos_adjuntos(pago_id);

-- El ticket + la reserva SÓLO se crean cuando un operador valida el pago.
CREATE TABLE tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id         UUID REFERENCES pedidos(id) ON DELETE SET NULL,
  pago_id           UUID REFERENCES pagos(id)   ON DELETE SET NULL,
  contenedor_numero TEXT REFERENCES contenedores(numero) ON DELETE SET NULL,
  estado            estado_ticket NOT NULL DEFAULT 'activo', -- activo -> cerrado
  pdf_url           TEXT,
  cerrado_en        TIMESTAMPTZ,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 7. ALERTAS (bandeja en tiempo real, alimentada por cron)
-- ---------------------------------------------------------------------
CREATE TABLE alertas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo          tipo_alerta   NOT NULL,
  referencia_id TEXT          NOT NULL,        -- numero contenedor / id pago / etc.
  mensaje       TEXT,
  estado        estado_alerta NOT NULL DEFAULT 'nueva',
  creado_en     TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_alertas_estado ON alertas(estado);
-- Evita duplicar alertas abiertas del mismo tipo/referencia:
CREATE UNIQUE INDEX uq_alerta_abierta
  ON alertas(tipo, referencia_id)
  WHERE estado <> 'resuelta';

-- ---------------------------------------------------------------------
-- 8. SESIONES DE CHAT (estado de flujo del bot, en DB por statelessness)
-- ---------------------------------------------------------------------
CREATE TABLE sesiones_chat (
  telefono      TEXT PRIMARY KEY,
  flujo         TEXT,                          -- 'cotizacion' | 'pago' | 'chofer' | null
  paso          TEXT,                          -- estado dentro del flujo
  contexto      JSONB NOT NULL DEFAULT '{}',   -- datos temporales del flujo (incluye modoHumano)
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  avisado_en    TIMESTAMPTZ                    -- cuándo se avisó "se va a cerrar el chat" (null = no avisado)
);

-- ---------------------------------------------------------------------
-- 8.a HILO DE CONVERSACIÓN (mensajes de texto entre cliente/bot/operador,
--     usado por el panel para mostrar el chat cuando un cliente pide asesor)
-- ---------------------------------------------------------------------
CREATE TYPE origen_mensaje_chat AS ENUM ('cliente', 'bot', 'operador');

CREATE TABLE mensajes_chat (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telefono   TEXT NOT NULL,
  origen     origen_mensaje_chat NOT NULL,
  texto      TEXT NOT NULL,
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL, -- sólo si origen = 'operador'
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mensajes_chat_telefono ON mensajes_chat(telefono, creado_en);

-- ---------------------------------------------------------------------
-- 8.a bis UBICACIONES DE LA EMPRESA (depósitos / vaciaderos)
-- ---------------------------------------------------------------------
CREATE TABLE ubicaciones (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo      tipo_ubicacion NOT NULL,
  nombre    TEXT NOT NULL,
  direccion TEXT NOT NULL,
  activo    BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ubicaciones_tipo ON ubicaciones(tipo) WHERE activo = TRUE;

-- ---------------------------------------------------------------------
-- 8.a ter RUTAS (pestaña "Ruta": pre-planificación del recorrido diario
-- de un chofer+camión). Las paradas viven en `viajes` (columnas ruta_id/
-- orden más abajo) — acá solo el "día de trabajo" y las paradas de
-- vaciado, que no son filas de `viajes` porque liberan TODO el set
-- "pendiente de vaciar" acumulado hasta ese punto, no un contenedor puntual.
-- ---------------------------------------------------------------------
CREATE TABLE rutas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha       DATE NOT NULL,
  chofer_id   UUID NOT NULL REFERENCES choferes(id) ON DELETE RESTRICT,
  -- Foto de choferes.patente al armar la ruta (mismo patrón que viajes.patente).
  patente     TEXT,
  estado      estado_ruta NOT NULL DEFAULT 'planificada',
  armada_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  notas       TEXT,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rutas_fecha_chofer ON rutas(fecha, chofer_id);
CREATE INDEX idx_rutas_estado ON rutas(estado);
-- Una sola ruta activa (no cancelada) por chofer por día.
CREATE UNIQUE INDEX ux_rutas_chofer_fecha ON rutas(chofer_id, fecha) WHERE estado <> 'cancelada';

CREATE TABLE ruta_vaciados (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruta_id      UUID NOT NULL REFERENCES rutas(id) ON DELETE CASCADE,
  orden        INT  NOT NULL,
  ubicacion_id UUID REFERENCES ubicaciones(id) ON DELETE SET NULL, -- vaciadero
  notas        TEXT,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ruta_id, orden)
);

-- ---------------------------------------------------------------------
-- 8.b VIAJES PROGRAMADOS (entrega / retiro)
-- ---------------------------------------------------------------------
CREATE TABLE viajes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo              tipo_viaje   NOT NULL,
  fecha             DATE         NOT NULL,
  chofer_id         UUID REFERENCES choferes(id)   ON DELETE SET NULL,
  contenedor_numero TEXT REFERENCES contenedores(numero) ON DELETE SET NULL,
  cliente_telefono  TEXT,
  -- Foto de la patente del chofer al momento de crear el viaje (se copia de
  -- choferes.patente): si el chofer cambia de camión después, este viaje ya
  -- programado/cerrado conserva la patente con la que realmente salió.
  patente           TEXT,
  zona              TEXT,
  -- Dirección del cliente: destino de una entrega, origen de un retiro.
  destino_direccion TEXT,
  -- Coordenadas GPS de esa dirección, si el cliente la compartió por WhatsApp
  -- como ubicación (en vez de escribirla) — permiten linkear a Google Maps
  -- desde el panel aunque no se haya podido resolver una dirección legible.
  destino_lat       NUMERIC(9,6),
  destino_lng       NUMERIC(9,6),
  -- Franja horaria que pidió el cliente (copiada de pedidos.horario_preferido
  -- al validar el pago; NULL si el viaje lo creó directo el operador).
  horario_preferido TEXT,
  -- Hora estimada que carga el operador desde el panel: de llegada si
  -- tipo='entrega', de retiro si tipo='retiro'. Independiente de lo anterior.
  hora_estimada     TIME,
  -- Ubicación propia de la empresa usada en este viaje: el depósito (si
  -- tipo='entrega', de donde sale el vacío) o el vaciadero (si
  -- tipo='retiro', adonde se lleva el lleno). ubicacion_direccion es una
  -- foto de la dirección al crear el viaje (mismo patrón que `patente`) para
  -- que el historial no cambie si después se edita/desactiva la ubicación.
  -- Origen/destino final de cada viaje se arma en las consultas según tipo
  -- (ver GET /api/viajes): entrega = ubicacion_direccion -> destino_direccion,
  -- retiro = destino_direccion -> ubicacion_direccion.
  ubicacion_id      UUID REFERENCES ubicaciones(id) ON DELETE SET NULL,
  ubicacion_direccion TEXT,
  estado            estado_viaje NOT NULL DEFAULT 'programado',
  -- Recambio: une la fila 'entrega' (vacío que deja) con la 'retiro' (lleno
  -- que se lleva) de una misma visita. NULL en un viaje normal.
  grupo_id          UUID,
  -- Pestaña "Ruta": si están seteados, esta fila es una parada dentro de la
  -- secuencia de `ruta_id`, en la posición `orden`. Un recambio en una ruta
  -- comparte ruta_id Y orden entre sus dos filas (misma visita física).
  ruta_id           UUID REFERENCES rutas(id) ON DELETE SET NULL,
  orden             INT,
  -- Número de remito y monto de ESTE movimiento puntual (a diferencia de
  -- pedidos.precio, que es el precio total cotizado del pedido). Vienen de
  -- la planilla Excel que ya usaban (ver excelClientes() en reportes.service.ts).
  remito            TEXT,
  importe           NUMERIC(12,2),
  notas             TEXT,
  creado_en         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actualizado_en    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_viajes_fecha  ON viajes(fecha);
CREATE INDEX idx_viajes_estado ON viajes(estado);
CREATE INDEX idx_viajes_grupo  ON viajes(grupo_id) WHERE grupo_id IS NOT NULL;
-- A lo sumo un viaje activo de cada tipo por contenedor (evita asignaciones
-- duplicadas/contradictorias a choferes distintos); entrega y retiro sí
-- pueden coexistir activos (el de entrega se cierra recién al confirmar el
-- retiro, ver contenedores.routes.ts /confirmar-retiro).
CREATE UNIQUE INDEX ux_viajes_activo_por_tipo
  ON viajes(contenedor_numero, tipo)
  WHERE estado IN ('programado', 'en_curso') AND contenedor_numero IS NOT NULL;

-- No puede haber orden sin ruta ni ruta sin orden: son la misma decisión.
ALTER TABLE viajes ADD CONSTRAINT chk_viajes_ruta_orden
  CHECK ((ruta_id IS NULL) = (orden IS NULL));
-- Unique por (ruta_id, orden, tipo): permite que entrega+retiro de un mismo
-- recambio compartan (ruta_id, orden) porque difieren en tipo, pero impide
-- que dos paradas DISTINTAS choquen en el mismo número.
CREATE UNIQUE INDEX ux_viajes_ruta_orden_tipo ON viajes(ruta_id, orden, tipo) WHERE ruta_id IS NOT NULL;
CREATE INDEX idx_viajes_ruta ON viajes(ruta_id) WHERE ruta_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 8.c IDEMPOTENCIA DEL WEBHOOK (dedupe por message_id de Meta)
-- ---------------------------------------------------------------------
CREATE TABLE mensajes_procesados (
  message_id TEXT PRIMARY KEY,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Housekeeping sugerido: borrar filas > 30 días con un cron.

-- ---------------------------------------------------------------------
-- 9. TRIGGERS: auditoría + validación de transiciones de contenedor
-- ---------------------------------------------------------------------

-- Matriz de transiciones permitidas.
CREATE OR REPLACE FUNCTION fn_validar_transicion_contenedor()
RETURNS TRIGGER AS $$
DECLARE
  permitido BOOLEAN := FALSE;
BEGIN
  IF NEW.estado = OLD.estado THEN
    RETURN NEW; -- sin cambio de estado
  END IF;

  permitido := CASE OLD.estado
    WHEN 'disponible'    THEN NEW.estado IN ('reservado','mantenimiento')
    WHEN 'reservado'     THEN NEW.estado IN ('entregado','disponible')      -- se libera si se cancela
    WHEN 'entregado'     THEN NEW.estado IN ('retirado')
    WHEN 'retirado'      THEN NEW.estado IN ('disponible','mantenimiento')
    WHEN 'mantenimiento' THEN NEW.estado IN ('disponible')
    ELSE FALSE
  END;

  IF NOT permitido THEN
    RAISE EXCEPTION 'Transición de contenedor inválida: % -> %', OLD.estado, NEW.estado
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

CREATE TRIGGER trg_validar_transicion_contenedor
  BEFORE UPDATE OF estado ON contenedores
  FOR EACH ROW EXECUTE FUNCTION fn_validar_transicion_contenedor();

-- Auditoría automática: cada cambio de estado inserta una fila en historial,
-- con quién lo hizo (mismo formato que contenedores.actualizado_por) para
-- poder resolver el nombre después. Única fuente de historial — el código
-- de la app no inserta filas manuales duplicadas (ver 0005_historial_actualizado_por.sql).
CREATE OR REPLACE FUNCTION fn_auditar_contenedor()
RETURNS TRIGGER AS $$
DECLARE
  v_chofer_id UUID;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.estado IS DISTINCT FROM OLD.estado THEN
    v_chofer_id := NULL;
    IF NEW.actualizado_por LIKE 'chofer:%' THEN
      BEGIN
        v_chofer_id := substring(NEW.actualizado_por FROM 8)::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        v_chofer_id := NULL;
      END;
    END IF;
    INSERT INTO historial_contenedores (numero_contenedor, estado, chofer_id, actualizado_por)
    VALUES (NEW.numero, NEW.estado, v_chofer_id, NEW.actualizado_por);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

CREATE TRIGGER trg_auditar_contenedor
  AFTER INSERT OR UPDATE OF estado ON contenedores
  FOR EACH ROW EXECUTE FUNCTION fn_auditar_contenedor();

-- touch actualizado_en en pagos
CREATE OR REPLACE FUNCTION fn_touch_actualizado()
RETURNS TRIGGER AS $$
BEGIN NEW.actualizado_en := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

CREATE TRIGGER trg_touch_pagos
  BEFORE UPDATE ON pagos
  FOR EACH ROW EXECUTE FUNCTION fn_touch_actualizado();

CREATE TRIGGER trg_touch_viajes
  BEFORE UPDATE ON viajes
  FOR EACH ROW EXECUTE FUNCTION fn_touch_actualizado();

CREATE TRIGGER trg_touch_rutas
  BEFORE UPDATE ON rutas
  FOR EACH ROW EXECUTE FUNCTION fn_touch_actualizado();

-- ---------------------------------------------------------------------
-- 10. AUTENTICACIÓN REFORZADA (MFA, sesiones, auditoría, dispositivos)
-- ---------------------------------------------------------------------

-- Refresh tokens: uno por sesión activa, encadenados por rotación. El valor
-- real nunca se guarda, sólo su hash (sha256) — igual que una contraseña.
CREATE TABLE sesiones (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id         UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  device_hash        TEXT,
  user_agent         TEXT,
  ip                 TEXT,
  recordar           BOOLEAN NOT NULL DEFAULT FALSE,   -- "recordarme": refresh de vida más larga
  reemplaza_a        UUID REFERENCES sesiones(id) ON DELETE SET NULL, -- cadena de rotación
  revocada_en        TIMESTAMPTZ,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en          TIMESTAMPTZ NOT NULL,
  ultimo_uso_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sesiones_usuario ON sesiones(usuario_id) WHERE revocada_en IS NULL;

-- Dispositivos ya vistos por usuario, para detectar logins desde uno nuevo.
CREATE TABLE dispositivos_conocidos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id     UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  device_hash    TEXT NOT NULL,
  user_agent     TEXT,
  ip_primera_vez TEXT,
  primera_vez    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_vez     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, device_hash)
);

-- Auditoría de todo evento relevante de autenticación.
CREATE TYPE tipo_evento_auth AS ENUM (
  'login_exitoso', 'login_fallido', 'mfa_fallido', 'bloqueo_temporal',
  'logout', 'password_reset_solicitado', 'password_reset_exitoso',
  'dispositivo_nuevo', 'sesion_revocada', 'refresh_reutilizado',
  'mfa_activado', 'mfa_desactivado'
);
CREATE TABLE auth_eventos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  email      TEXT,                     -- se guarda aunque el usuario no exista (login fallido a email inexistente)
  tipo       tipo_evento_auth NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  detalle    JSONB,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_eventos_usuario ON auth_eventos(usuario_id, creado_en DESC);
CREATE INDEX idx_auth_eventos_creado  ON auth_eventos(creado_en DESC);

-- Tokens de un solo uso: invitación de alta y reset de contraseña.
CREATE TYPE tipo_token_accion AS ENUM ('invitacion', 'reset_password');
CREATE TABLE tokens_accion (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo       tipo_token_accion NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 del token real (el real sólo viaja por email)
  expira_en  TIMESTAMPTZ NOT NULL,
  usado_en   TIMESTAMPTZ,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tokens_accion_usuario ON tokens_accion(usuario_id);

-- ---------------------------------------------------------------------
-- 11. ROW LEVEL SECURITY
-- El backend accede con conexión directa (pg.Pool), no vía la API
-- PostgREST de Supabase: no hacen falta policies, solo bloquear el
-- acceso público (roles anon/authenticated) por defecto.
-- ---------------------------------------------------------------------
ALTER TABLE usuarios               ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE choferes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tarifas_departamento   ENABLE ROW LEVEL SECURITY;
ALTER TABLE contenedores           ENABLE ROW LEVEL SECURITY;
ALTER TABLE historial_contenedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos_adjuntos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets                ENABLE ROW LEVEL SECURITY;
ALTER TABLE alertas                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sesiones_chat          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensajes_chat          ENABLE ROW LEVEL SECURITY;
ALTER TABLE viajes                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ubicaciones            ENABLE ROW LEVEL SECURITY;
ALTER TABLE rutas                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ruta_vaciados          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensajes_procesados    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sesiones               ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispositivos_conocidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_eventos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens_accion          ENABLE ROW LEVEL SECURITY;

COMMIT;
