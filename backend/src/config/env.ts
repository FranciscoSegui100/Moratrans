import 'dotenv/config';
import { z } from 'zod';

// Todas las credenciales viven en variables de entorno. Nada hardcodeado.
const schema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Lista separada por comas: permite tener el localhost de desarrollo y el
  // dominio de producción habilitados al mismo tiempo (CORS + cookies con credentials).
  CORS_ORIGIN: z.string().default('http://localhost:5173')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  DATABASE_URL: z.string().url(),

  // Firma del access token (JWT, va en la cookie httpOnly mt_at). 8h en vez
  // de los 15 min originales: cubre un turno entero sin que haga falta
  // renovar ni una vez. La renovación (access + CSRF) sigue pasando sola de
  // fondo (AuthContext, cada 10 min o al volver a la pestaña) para que la
  // sesión no corte ni siquiera en turnos más largos — este número es el
  // margen de seguridad para cuando esa renovación automática no llegó a
  // tiempo, no el único mecanismo del que depende.
  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES: z.string().default('8h'),
  // Vida del refresh token (opaco, hasheado en la tabla `sesiones`, cookie mt_rt).
  REFRESH_TTL_DIAS: z.coerce.number().default(30),
  REFRESH_TTL_RECORDAR_DIAS: z.coerce.number().default(90),
  WA_GRAPH_VERSION: z.string().default('v21.0'),
  WA_PHONE_NUMBER_ID: z.string().default('000000000000000'),
  WA_ACCESS_TOKEN: z.string().default('mock'),
  WA_VERIFY_TOKEN: z.string().default('dev-verify'),
  WA_APP_SECRET: z.string().default(''),

  SYNC_API_KEY: z.string().min(16),

  // Comprobantes/facturas/tickets viven en un bucket privado de Supabase
  // Storage (no en disco: el filesystem de Railway es efímero y se pierde en
  // cada redeploy). service_role porque el backend valida el acceso vía RBAC,
  // no vía RLS de Supabase.
  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_STORAGE_BUCKET: z.string().default('media'),

  // ---- Email transaccional (Resend): reset de contraseña, invitación, alertas ----
  RESEND_API_KEY: z.string().min(1),
  // Mientras no haya un dominio propio verificado en Resend, "onboarding@resend.dev"
  // es el remitente de pruebas: solo entrega a la casilla con la que te registraste.
  EMAIL_FROM: z.string().default('Moratrans <onboarding@resend.dev>'),
  // Base para los links de los emails (reset de contraseña, invitación).
  APP_URL: z.string().url().default('http://localhost:5173'),

  // Clave de cifrado en reposo: 64 caracteres hex (32 bytes) para AES-256-GCM.
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY debe ser 64 hex (32 bytes)'),
}).superRefine((val, ctx) => {
  // En producción el secreto del webhook es obligatorio: sin él, verifySignature
  // quedaría en modo "permitir todo" y cualquiera podría spoofear mensajes de WhatsApp.
  if (val.NODE_ENV === 'production' && val.WA_APP_SECRET.length < 16) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WA_APP_SECRET'],
      message: 'WA_APP_SECRET es obligatorio (min 16 chars) en producción',
    });
  }
  // En producción los comprobantes/facturas/tickets tienen que persistir en
  // Supabase Storage: sin esto, se guardarían en el disco efímero de Railway
  // y se perderían en el próximo redeploy.
  if (val.NODE_ENV === 'production' && (!val.SUPABASE_URL || !val.SUPABASE_SERVICE_ROLE_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SUPABASE_URL'],
      message: 'SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son obligatorios en producción',
    });
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Variables de entorno inválidas:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
