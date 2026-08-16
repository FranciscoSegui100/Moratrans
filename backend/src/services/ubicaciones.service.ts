import { query } from '../config/db';

export type TipoUbicacion = 'deposito' | 'vaciadero';

export interface UbicacionResuelta {
  id: string;
  direccion: string;
}

/**
 * Resuelve qué ubicación (depósito para una entrega, vaciadero para un
 * retiro) usar en un viaje nuevo. Si se pasa un id explícito, lo valida
 * (tiene que existir, ser del tipo correcto y estar activo) y devuelve su
 * dirección actual. Si no se pasa ninguno y hay UNA sola ubicación activa de
 * ese tipo, se autoselecciona — evita pedirle al operador/chofer que elija
 * mientras la empresa todavía tiene un solo depósito/vaciadero cargado.
 * Devuelve null si no se puede resolver (id inválido, o ninguna/varias
 * activas sin especificar) — cada caller decide si eso es un error 400 (el
 * panel, que sí puede pedirle a la persona que elija) o si simplemente deja
 * el viaje sin ubicación para completarlo después (los flujos del bot).
 */
export async function resolverUbicacion(
  tipo: TipoUbicacion,
  ubicacionId?: string | null,
): Promise<UbicacionResuelta | null> {
  if (ubicacionId) {
    const [row] = await query<UbicacionResuelta>(
      'SELECT id, direccion FROM ubicaciones WHERE id = $1 AND tipo = $2 AND activo = TRUE',
      [ubicacionId, tipo],
    );
    return row ?? null;
  }
  const activas = await query<UbicacionResuelta>(
    'SELECT id, direccion FROM ubicaciones WHERE tipo = $1 AND activo = TRUE ORDER BY creado_en LIMIT 2',
    [tipo],
  );
  return activas.length === 1 ? activas[0] : null;
}
