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

  // Firma del access token (JWT, va en la cookie httpOnly mt_at). 2h de duración:
  // margen de seguridad para sesiones activas. La renovación (access + CSRF)
  // sigue pasando sola de fondo (AuthContext, cada 10 min o al volver a la pestaña)
  // para que la sesión no corte mientras el usuario trabaje.
  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES: z.string().default('2h'),
  // Vida del refresh token (opaco, hasheado en la tabla `sesiones`, cookie mt_rt).
  // Sin "Recordarme": se cierra tras estas horas SIN USO real del panel
  // (mouse/teclado/toques, ver frontend/src/lib/actividad.ts) — no cuenta la
  // renovación automática de fondo, que si no mantenía viva para siempre una
  // pestaña abierta en una compu de la oficina.
  SESION_INACTIVIDAD_HORAS: z.coerce.number().positive().default(12),
  // Con "Recordarme": días desde el último uso (pensado para el celular o la compu personal).
  REFRESH_TTL_RECORDAR_DIAS: z.coerce.number().default(30),
  WA_GRAPH_VERSION: z.string().default('v21.0'),
  WA_PHONE_NUMBER_ID: z.string().default('000000000000000'),
  WA_ACCESS_TOKEN: z.string().default('mock'),
  WA_VERIFY_TOKEN: z.string().default('dev-verify'),
  WA_APP_SECRET: z.string().default(''),
  // Content IDs (retailer_id) de los productos del catálogo de WhatsApp que
  // son alquiler de contenedores, separados por coma. Un pedido del catálogo
  // con solo esos productos arranca el flujo de cotización en vez de escalar
  // a un asesor (ver messageRouter.ts). Vacío = todo pedido va al asesor.
  // Default: el Content ID que tiene hoy el producto "Contenedores".
  WA_CATALOGO_IDS_CONTENEDOR: z.string().default('Contenedores'),

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
  // En producción usar una dirección del dominio verificado en Resend
  // (ej. "Moratrans <no-reply@moratrans.ar>"). "onboarding@resend.dev" es el
  // remitente de pruebas: solo entrega a la casilla con la que te registraste.
  EMAIL_FROM: z.string().default('Moratrans <onboarding@resend.dev>'),
  // Base para los links de los emails (reset de contraseña, invitación).
  APP_URL: z.string().url().default('http://localhost:5173'),

  // Clave de cifrado en reposo: 64 caracteres hex (32 bytes) para AES-256-GCM.
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY debe ser 64 hex (32 bytes)'),

  // Cuenta a la que el cliente transfiere para pagar (se muestra en el chat,
  // ver pago.flow.ts / cotizacion.flow.ts).
  PAGO_CBU: z.string().default('0000003100098659888038')
    .transform((v) => (v === '0000003100000000000001' ? '0000003100098659888038' : v)),
  PAGO_ALIAS: z.string().default('moratranss')
    .transform((v) => (v === 'MORATRANS.PAGOS' ? 'moratranss' : v)),
  PAGO_TITULAR_CUENTA: z.string().default('')
    .transform((v) => (v === 'Moratrans SA' ? '' : v)),
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
