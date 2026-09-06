import { query } from '../config/db';

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
  const [row] = await query<Cliente>(
    `INSERT INTO clientes (nombre, telefono)
     VALUES (COALESCE($2, 'Sin nombre'), $1)
     ON CONFLICT (telefono) DO UPDATE SET nombre = COALESCE($2, clientes.nombre)
     RETURNING id, nombre, telefono, cuenta_corriente_estado`,
    [telefono, nombre ?? null],
  );
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
