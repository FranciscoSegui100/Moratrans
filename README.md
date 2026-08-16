# Sistema de Gestión Logística + Chatbot WhatsApp

Monorepo con dos aplicaciones que **nunca se comunican directamente**: ambas leen
y escriben sobre **PostgreSQL**, la única fuente de verdad.

> 🚀 **¿Arrancás de cero?** Leé **`EMPEZAR.md`**: con Docker Desktop instalado, un solo
> comando (`docker compose up -d --build`) levanta base + backend + panel.

```
┌────────────────┐        ┌──────────────────────┐        ┌────────────────┐
│  WhatsApp /     │  HTTP  │   Backend (Node/TS)   │  SQL   │  PostgreSQL     │
│  Graph API      │◄──────►│  webhook + API + cron │◄──────►│ (fuente de      │
└────────────────┘        │  + Socket.io          │        │  verdad)        │
                          └──────────┬───────────┘        └───────┬────────┘
                                     │ Socket.io (alertas)         │ pull /sync
                          ┌──────────▼───────────┐        ┌────────▼────────┐
                          │ Panel Admin (React)  │        │ Servidor interno │
                          │ Vite + Tailwind      │        │ del cliente      │
                          └──────────────────────┘        └─────────────────┘
```

## Stack
- **Backend / Chatbot**: Node.js + TypeScript + Express, integración **directa** con la
  Graph API de Meta (webhook `/messages` y `/media`). Sin frameworks de terceros.
- **DB**: PostgreSQL (esquema, enums, triggers de auditoría y validación de estados).
- **Tiempo real**: Socket.io (backend → panel).
- **Frontend**: React + Vite + Tailwind con RBAC en la UI.

## Puesta en marcha

> **¿Solo querés probarlo?** Seguí `TESTING.md`: con `docker compose up -d` levantás la
> base ya inicializada (schema + seed) y probás todo el panel sin depender de Meta.

### 1. Base de datos
```bash
createdb logistica
cd backend
cp .env.example .env        # completar credenciales
# Generá una clave de cifrado real y pegala en ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm install
npm run db:schema           # crea tablas, enums, triggers
npm run db:seed             # tarifas, usuario admin (admin@empresa.com / Admin1234!)
npm run db:seed-choferes    # chofer inicial con DNI CIFRADO (no va en el SQL)
```

### 2. Backend
```bash
npm run dev                 # http://localhost:4000
```

### 3. Frontend
```bash
cd frontend
cp .env.example .env
npm install
npm run dev                 # http://localhost:5173
```

## Webhook de Meta
- **Verificación**: `GET /webhook` responde el `hub.challenge` si `WA_VERIFY_TOKEN` coincide.
- **Recepción**: `POST /webhook` valida la firma `X-Hub-Signature-256` con `WA_APP_SECRET`,
  responde 200 de inmediato y procesa async.

## Flujos del chatbot
1. **Cotización**: `list message` con departamentos → **confirmación explícita** → precio.
   Las tarifas se leen de `tarifas_departamento` (nunca hardcodeadas).
2. **Pago**: el comprobante se descarga vía `/media`, se registra el pago como
   `pendiente`. **No** se crea ticket ni se reserva contenedor automáticamente.
3. **Validación manual** (panel): un operador valida → `fn_validar_pago` reserva un
   contenedor y crea el ticket de forma **atómica** → se genera el PDF (pdfkit) y se
   envía por `/media`.
4. **Chofer**: identificación por teléfono; si no se reconoce, se pide DNI; si coincide
   se vincula, si no se deriva a un operador (alerta). Sólo puede aplicar estados
   logísticos: `entregado`, `retirado`.

## Máquina de estados del contenedor
Validada por trigger `fn_validar_transicion_contenedor`:
```
disponible → reservado → entregado → retirado → disponible
     ↘ mantenimiento ↗                        ↘ mantenimiento
```

## Tareas en segundo plano
`node-cron` cada 15 min revisa **contenedores por vencer** (48h) y **pagos vencidos**
(24h sin validar), inserta en `alertas` (sin duplicar por índice único parcial) y
emite `nueva_alerta` por Socket.io a la sala `alertas`.

## Sincronización con el servidor interno del cliente
El servidor del cliente inicia una **conexión saliente periódica** (pull) contra
`GET /api/sync/pull?since=<ISO>`, autenticada por `x-sync-key`. Devuelve las filas
modificadas desde `since` por entidad y un `serverTime` para el próximo corte.
Es replicación de lectura; la DB central sigue siendo la fuente de verdad.

## Seguridad / RBAC
- Roles: `admin`, `operador`, `finanzas`, `lectura`.
- **DNI de choferes**: visible sólo para `admin`/`operador` (enmascarado en el resto).
- **Comprobantes de pago**: visibles sólo para `admin`/`finanzas`.
- Enmascarado aplicado en el backend (`filtrarSensibles`) y reforzado en la UI (`RoleGate`).
- Todas las credenciales se manejan por variables de entorno (`.env`, nunca en el repo).

## Funcionalidades agregadas (esta versión)

- **Estados del ticket** (`activo → cerrado`): `POST /api/tickets/:id/cerrar` cierra el
  ticket al finalizar el servicio y libera el contenedor si estaba `retirado`.
- **Idempotencia del webhook**: cada `message_id` de Meta se registra en
  `mensajes_procesados`; los reintentos duplicados se ignoran.
- **Timeout de sesión (30 min)**: una sesión de chat inactiva se descarta y el usuario
  vuelve al menú (`SESION_TTL_MIN` en `session.store.ts`).
- **Viajes programados**: entidad `viajes` + `GET/POST /api/viajes`, `PATCH /api/viajes/:id`
  y la vista *Viajes* en el panel (crear, asignar, cambiar estado).
- **Exportación de reportes**: `GET /api/reportes/contenedores.xlsx` (exceljs) y
  `GET /api/reportes/pagos.pdf` (pdfkit), descargables desde la vista *Reportes*.
- **Cifrado en reposo** (AES-256-GCM en la app; la clave nunca toca la DB): DNI de
  choferes y URL de comprobantes. El DNI usa un **blind index** (HMAC) para poder
  buscarse sin descifrar. La clave vive en `ENCRYPTION_KEY` (idealmente desde un KMS).
- **Plantillas de WhatsApp**: `sendTemplate()` para mensajes proactivos fuera de la
  ventana de 24 h. Ejemplo: `POST /api/pedidos/:id/recordar-pago` usa la plantilla
  `recordatorio_pago` (debe estar **aprobada** en el WhatsApp Manager, con 2 variables:
  zona y precio).

## Notas para producción
- Servir `MEDIA_DIR` detrás de auth (hoy los comprobantes se sirven por ruta local; en
  producción usar S3/GCS con URLs firmadas).
- Rotar `WA_ACCESS_TOKEN` y usar tokens de sistema.
- Añadir rate-limiting al webhook y a `/api/auth/login`.
- El hash del admin en el seed es de ejemplo: regenerarlo con bcrypt antes de usar.
# Moratrans
