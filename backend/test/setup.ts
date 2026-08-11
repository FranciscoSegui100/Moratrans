/**
 * Valores dummy para que config/env.ts (que valida TODO process.env al
 * importarse y mata el proceso si algo falta) pueda parsear sin quejarse en
 * los tests. Ninguno de estos se usa para conectarse a nada real — con
 * NODE_ENV=test no se exige SUPABASE_URL/WA_APP_SECRET (solo obligatorios en
 * producción). No pisa lo que ya esté seteado (por si algún test puntual lo
 * necesita distinto).
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/test';
process.env.JWT_SECRET ??= 'clave-de-test-no-usar-en-serio';
process.env.SYNC_API_KEY ??= 'clave-de-test-no-usar-en-serio';
process.env.RESEND_API_KEY ??= 'test-resend-key';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
