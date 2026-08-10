import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' }, // proxy al backend en dev
  },
  build: {
    // En producción (Railway) el backend sirve este build como estáticos, así
    // ambos quedan bajo el mismo dominio (sin eso, la cookie mt_csrf no se
    // puede leer entre dominios distintos — ver backend/src/app.ts).
    outDir: '../backend/public',
    emptyOutDir: true,
  },
});
