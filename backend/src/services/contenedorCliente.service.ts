import { query } from '../config/db';

export interface ContenedorCliente {
  numero: string;
  zona: string | null;
  destino_direccion: string | null;
  destino_lat: number | null;
  destino_lng: number | null;
}

/**
 * Contenedores actualmente entregados a este teléfono, según su entrega
 * activa más reciente. Usado por los flujos de recambio y de pedir retiro
 * (el cliente elige entre SUS contenedores, no cualquiera).
 */
export async function contenedoresDelCliente(telefono: string): Promise<ContenedorCliente[]> {
  return query<ContenedorCliente>(
    `SELECT c.numero, ultima.zona, ultima.destino_direccion, ultima.destino_lat, ultima.destino_lng
       FROM contenedores c
       CROSS JOIN LATERAL (
         SELECT v.zona, v.destino_direccion, v.destino_lat, v.destino_lng, v.cliente_telefono
           FROM viajes v
          WHERE v.contenedor_numero = c.numero AND v.tipo = 'entrega' AND v.estado IN ('programado', 'en_curso')
          ORDER BY v.creado_en DESC LIMIT 1
       ) ultima
      WHERE c.estado = 'entregado' AND ultima.cliente_telefono = $1
      ORDER BY c.numero`,
    [telefono],
  );
}
