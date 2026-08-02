# EMPEZAR — cómo correr el proyecto desde cero

No hace falta que tengas nada instalado de antes. Elegí **una** de las tres opciones.
La **Opción A (Docker)** es la más simple: instalás una sola herramienta y corrés un
comando.

> Este proyecto ya fue ejecutado y probado de punta a punta (login, KPIs, validación de
> pago con reserva de contenedor, reportes Excel/PDF, RBAC, alertas y cifrado). Si seguís
> estos pasos, arranca.

---

## Opción A — Todo con Docker (recomendada, 1 comando)

Solo necesitás **Docker Desktop**. No instalás Node ni PostgreSQL.

### 1. Instalar Docker Desktop
- **Windows**: descargá Docker Desktop de docker.com/products/docker-desktop, instalá,
  reiniciá. (En Windows Home necesita WSL2; el instalador lo configura.)
- **Mac**: descargá Docker Desktop (elegí el chip: Apple Silicon o Intel), instalá, abrilo.
- **Linux**: instalá Docker Engine + el plugin `docker compose` desde docs.docker.com/engine/install.

Verificá que quedó listo:
```bash
docker --version
docker compose version
```

### 2. Descomprimir el proyecto y entrar a la carpeta
```bash
cd logistica-whatsapp
```

### 3. Levantar todo
```bash
docker compose up -d --build
```
La primera vez tarda unos minutos (descarga imágenes y compila). Cuando termina, tenés:
- Panel de administración → http://localhost:5173
- API / backend → http://localhost:4000
- Adminer (ver la base) → http://localhost:8080
- Base PostgreSQL → puerto 5432

### 4. Entrar al panel
Abrí http://localhost:5173 y logueá con:
```
admin@empresa.com  /  Admin1234!
```

### Comandos útiles
```bash
docker compose logs -f backend      # ver logs del backend
docker compose ps                   # estado de los servicios
docker compose down                 # apagar (conserva los datos)
docker compose down -v && docker compose up -d --build   # RESET total (borra datos)
```

Con esto probás todo el panel sin depender de Meta. Para el chatbot real de WhatsApp,
seguí la **Fase 2** de `TESTING.md` (número de prueba de Meta + ngrok).

---

## Opción B — Base en Docker + Node local (mejor para desarrollar)

Da hot-reload y logs directos. Necesitás **Docker** y **Node.js 20+**.

1. Instalar Node.js 20 LTS desde nodejs.org (o con nvm).
2. Levantar solo la base:
   ```bash
   docker compose up -d db adminer
   ```
3. Backend:
   ```bash
   cd backend
   cp .env.example .env
   # editar .env: DATABASE_URL apuntando a localhost:5432, WA_APP_SECRET vacío
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # pegar en ENCRYPTION_KEY
   npm install
   npm run db:seed-choferes
   npm run dev        # http://localhost:4000
   ```
4. Frontend (otra terminal):
   ```bash
   cd frontend
   cp .env.example .env
   npm install
   npm run dev        # http://localhost:5173
   ```

---

## Opción C — Todo nativo, sin Docker

Necesitás **Node.js 20+** y **PostgreSQL 16**.

1. Instalar Node.js 20 LTS (nodejs.org) y PostgreSQL 16 (postgresql.org/download).
2. Crear la base y cargar esquema + seed:
   ```bash
   createdb logistica
   cd backend
   cp .env.example .env      # ajustar DATABASE_URL a tu Postgres; WA_APP_SECRET vacío
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # -> ENCRYPTION_KEY
   npm install
   npm run db:schema
   npm run db:seed
   npm run db:seed-choferes
   npm run dev
   ```
3. Frontend:
   ```bash
   cd ../frontend
   cp .env.example .env
   npm install
   npm run dev
   ```

Atajo en Mac/Linux: desde `backend/` podés usar `./start-dev.sh` (arranca backend y
frontend juntos, asumiendo que la base ya existe).

---

## ¿Y ahora qué?
1. Recorré el panel con el checklist de `TESTING.md`.
2. Cuando quieras el bot real, hacé la Fase 2 (Meta + ngrok) de `TESTING.md`.
3. Para producción segura (RDS/Cloud SQL + backend en contenedor), pedímelo y armamos el deploy.
