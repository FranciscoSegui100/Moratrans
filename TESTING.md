# Guía de testeo

Dos fases: **Fase 1** prueba casi todo localmente sin Meta. **Fase 2** conecta el
número de prueba de Meta para probar la conversación real del bot.

---

## Fase 1 — Todo el panel, sin Meta (10 min)

### 1. Base de datos con Docker
Desde la raíz del proyecto:
```bash
docker compose up -d
```
Esto levanta PostgreSQL **ya inicializado** con el esquema y el seed, más Adminer en
http://localhost:8080 (System: PostgreSQL · Server: `db` · User: `postgres` ·
Pass: `postgres` · Database: `logistica`).

> Si ya tenés PostgreSQL instalado y preferís no usar Docker: `createdb logistica`,
> y luego desde `backend/`: `npm run db:schema && npm run db:seed`.

### 2. Backend
```bash
cd backend
cp .env.example .env
```
Para probar local sin Meta, editá dos líneas del `.env`:
- Dejá **`WA_APP_SECRET=`** vacío (así el webhook no exige firma y podés simular con curl).
- Generá una clave de cifrado real y pegала en `ENCRYPTION_KEY`:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
Los valores de `WA_PHONE_NUMBER_ID` / `WA_ACCESS_TOKEN` podés dejarlos como están: el
backend arranca igual; solo fallará el **envío** de mensajes a WhatsApp (esperable sin token real).

```bash
npm install
npm run db:seed-choferes   # carga el chofer inicial con DNI cifrado
npm run dev                # http://localhost:4000
```

### 3. Panel
```bash
cd ../frontend
cp .env.example .env
npm install
npm run dev                # http://localhost:5173
```

### 4. Qué probar en el panel (sin Meta)
Login: **admin@empresa.com / Admin1234!**
- **Dashboard**: los KPIs salen de la base real (el seed ya trae contenedores).
- **Viajes**: creá un viaje, cambiá su estado. Se persiste en la tabla `viajes`.
- **Reportes**: descargá el Excel de contenedores y el PDF de pagos.
- **Choferes**: el DNI se ve completo con rol admin. (Ver RBAC abajo.)
- **Alertas**: el seed trae el contenedor `MSKU1000003` venciendo en 2 días, así que el
  cron al arrancar el backend genera una alerta `contenedor_por_vencer`. Refrescá /alertas.

### 5. Probar validación de pago → ticket + reserva (sin Meta)
Insertá un pago pendiente (por Adminer, o por SQL):
```sql
INSERT INTO pedidos (cliente_telefono, zona, precio, estado)
VALUES ('5492610000000', 'Montevideo', 12000, 'cotizado');

INSERT INTO pagos (cliente_telefono, pedido_id, monto, estado)
VALUES ('5492610000000',
        (SELECT id FROM pedidos ORDER BY creado_en DESC LIMIT 1),
        12000, 'pendiente');
```
En el panel → **Validar pagos** → *Validar*. Vas a ver que:
- se reserva un contenedor disponible y se crea el ticket (función atómica `fn_validar_pago`),
- el panel muestra el número de ticket y contenedor,
- el **envío del PDF** por WhatsApp falla (sin token real) — es lo único que no corre local.

### 6. Probar el RBAC
Creá un usuario de rol `lectura` o `finanzas` para ver el enmascarado:
```sql
-- password: Admin1234!  (mismo hash del seed)
INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES
 ('Solo lectura', 'lectura@empresa.com',
  '$2b$10$8cumT3uw.LuGsZR7uORe9.QjekojMnoCoCjEyIMWoSCs1txxIs0m6', 'lectura');
```
Entrá con ese usuario: el DNI de choferes aparece como `••••••` y no ves los botones de validar.

### 7. Simular un mensaje entrante por curl (opcional)
Con `WA_APP_SECRET` vacío podés golpear el webhook directo. Esto prueba que el mensaje
**se recibe, se deduplica y se enruta** (la respuesta al cliente fallará sin token real):
```bash
curl -X POST http://localhost:4000/webhook \
  -H "Content-Type: application/json" \
  -d '{"entry":[{"changes":[{"value":{"messages":[
      {"from":"5492610000000","id":"wamid.TEST-1","type":"text","text":{"body":"cotizar"}}
    ]}}]}]}'
```
Repetí el mismo comando: en los logs vas a ver *"Mensaje duplicado ignorado"* (idempotencia).

---

## Fase 2 — Chatbot real con el número de prueba de Meta (20-30 min)

El número de **prueba** de Meta funciona sin esperar la verificación del negocio; solo
podés escribirle desde números que registres como destinatarios.

1. En developers.facebook.com creá una app *Business* → agregá el producto *WhatsApp*.
2. En *API Setup*: copiá `WA_PHONE_NUMBER_ID` y el **token temporal** a tu `.env`.
   Registrá tu WhatsApp personal como número destinatario de prueba.
3. En *Configuración → Básica*: copiá el `App Secret` a `WA_APP_SECRET` (ahora sí, con valor).
4. Exponé el backend con un túnel HTTPS:
   ```bash
   npx ngrok http 4000
   ```
5. En *WhatsApp → Configuration → Webhook*: Callback URL `https://xxxx.ngrok-free.app/webhook`,
   Verify Token = tu `WA_VERIFY_TOKEN`. Guardá y **suscribite al campo `messages`**.
6. Reiniciá el backend (para tomar el token real) y escribile "hola" al número de prueba.
   Deberías recibir el menú, poder cotizar, mandar una foto como comprobante (aparece la
   alerta en el panel) y, al validar, recibir el PDF del ticket.

> Recordá: el token temporal vence a las 24 h. Para que no se corte, configurá un
> *System User* con token permanente. Y las **plantillas** (recordatorio de pago) hay que
> darlas de alta y esperar su aprobación en el WhatsApp Manager.

---

## Checklist rápido de "funciona"
- [ ] `docker compose up -d` deja la base con tablas y datos.
- [ ] Login al panel con admin.
- [ ] Crear/mover un viaje.
- [ ] Descargar Excel y PDF.
- [ ] Validar un pago insertado a mano → se crea ticket y se reserva contenedor.
- [ ] Un usuario `lectura` ve el DNI enmascarado.
- [ ] (Fase 2) El bot responde el menú y completa cotización + comprobante + ticket.
