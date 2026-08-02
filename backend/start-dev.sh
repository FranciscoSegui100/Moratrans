#!/usr/bin/env bash
# Arranca backend y frontend juntos en modo desarrollo (Opción C).
# Asume que la base ya existe y el .env está configurado.
set -e
cd "$(dirname "$0")"

echo "▶ Backend en http://localhost:4000"
npm run dev &
BACK=$!

cd ../frontend
echo "▶ Frontend en http://localhost:5173"
npm run dev &
FRONT=$!

trap "kill $BACK $FRONT 2>/dev/null" EXIT
wait
