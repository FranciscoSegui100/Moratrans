# Backend: build de TypeScript + arranque. Carga el chofer cifrado y levanta el server.
FROM node:20-slim

WORKDIR /app

# Instalar dependencias primero (mejor cache)
COPY package.json ./
RUN npm install

# Copiar el código y compilar
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
EXPOSE 4000

# Carga idempotente del chofer inicial (ON CONFLICT DO NOTHING) y arranque del server.
CMD ["sh", "-c", "node dist/db/seedChoferes.js || true && node dist/server.js"]
