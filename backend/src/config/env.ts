import 'dotenv/config';
import { z } from 'zod';

// Todas las credenciales viven en variables de entorno. Nada hardcodeado.
const schema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173').transform((s) => s.trim()),

  DATABASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES: z.string().default('8h'),
  WA_GRAPH_VERSION: z.string().default('v21.0'),
  WA_PHONE_NUMBER_ID: z.string().default('000000000000000'),
  WA_ACCESS_TOKEN: z.string().default('mock'),
  WA_VERIFY_TOKEN: z.string().default('dev-verify'),
  WA_APP_SECRET: z.string().default(''),

  SYNC_API_KEY: z.string().min(16),
  MEDIA_DIR: z.string().default('./storage'),

  // Clave de cifrado en reposo: 64 caracteres hex (32 bytes) para AES-256-GCM.
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY debe ser 64 hex (32 bytes)'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Variables de entorno inválidas:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
