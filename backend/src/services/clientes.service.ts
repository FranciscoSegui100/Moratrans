import { query } from '../config/db';
import { emitConversacionActualizada } from '../config/socket';

export interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  cuenta_corriente_estado: 'sin_pedir' | 'pendiente' | 'aprobada' | 'rechazada';
}

/**
 * Da de alta al cliente la primera vez que se lo ve (cotización o pedido de
 * cuenta corriente) y refresca el nombre si vino uno nuevo del perfil de
 * WhatsApp. `clientes` se referencia siempre por teléfono, igual que
 * pedidos/pagos/viajes (ver comentario de cabecera de schema.sql) — no hay
 * cliente_id en esas tablas.
 */
export async function obtenerOCrearCliente(telefono: string, nombre?: string | null): Promise<Cliente> {
  const nombreLimpio = nombre?.trim() ? nombre.trim() : null;
  const [row] = await query<Cliente>(
    `INSERT INTO clientes (nombre, telefono)
     VALUES (COALESCE($2, 'Sin nombre'), $1)
     ON CONFLICT (telefono) DO UPDATE SET nombre = CASE 
       WHEN $2 IS NOT NULL AND $2 <> '' AND $2 <> 'Sin nombre' THEN $2 
       ELSE clientes.nombre 
     END
     RETURNING id, nombre, telefono, cuenta_corriente_estado`,
    [telefono, nombreLimpio],
  );
  if (row?.nombre && row.nombre !== 'Sin nombre') {
    emitConversacionActualizada({ telefono, nombre: row.nombre });
  }
  return row;
}

/**
 * El nombre de perfil de WhatsApp no siempre está puesto (queda "Sin
 * nombre" en el panel) — se usa recién al confirmar un pedido, no en el
 * primer contacto, para no dar de alta un cliente por cada teléfono que
 * solo anduvo mirando el menú sin llegar a pedir nada.
 */
export async function necesitaNombre(telefono: string): Promise<boolean> {
  const [row] = await query<{ nombre: string }>('SELECT nombre FROM clientes WHERE telefono = $1', [telefono]);
  return !row || row.nombre === 'Sin nombre';
}

/**
 * Última dirección de entrega conocida de este teléfono (de un pedido
 * cotizado o de un viaje ya creado) — se ofrece como atajo en vez de
 * pedírsela de cero (ver pedidoCatalogo.flow.ts). null si no hay ninguna.
 */
export async function ultimaDireccionCliente(telefono: string): Promise<string | null> {
  const [row] = await query<{ destino_direccion: string | null }>(
    `SELECT destino_direccion FROM (
       SELECT destino_direccion, creado_en FROM pedidos WHERE cliente_telefono = $1 AND destino_direccion IS NOT NULL
       UNION ALL
       SELECT destino_direccion, creado_en FROM viajes WHERE cliente_telefono = $1 AND destino_direccion IS NOT NULL
     ) t
     ORDER BY creado_en DESC LIMIT 1`,
    [telefono],
  );
  return row?.destino_direccion ?? null;
}
