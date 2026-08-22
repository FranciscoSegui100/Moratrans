import { query } from '../config/db';
import { contenedoresDelCliente } from './contenedorCliente.service';

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
 * Nunca cotizó, nunca pagó (no hay fila en `clientes` — se crea recién al
 * completar una cotización o un pago, ver arriba) y no tiene un contenedor
 * entregado a su nombre. Se usa para simplificar el primer contacto por
 * WhatsApp (menú de un solo paso + cotización sin selector de departamento,
 * ver messageRouter.ts y cotizacion.flow.ts) — el resto de las opciones no
 * tienen sentido todavía para alguien que nunca usó el servicio.
 */
export async function esClienteNuevo(telefono: string): Promise<boolean> {
  const [cliente] = await query<{ id: string }>('SELECT id FROM clientes WHERE telefono = $1', [telefono]);
  if (cliente) return false;
  return (await contenedoresDelCliente(telefono)).length === 0;
}
