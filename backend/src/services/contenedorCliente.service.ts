import { query } from '../config/db';

export interface ContenedorCliente {
  numero: string;
  zona: string | null;
  destino_direccion: string | null;
  destino_lat: number | null;
  destino_lng: number | null;
}

/**
 * Contenedores actualmente entregados a este teléfono, según su entrega más
 * reciente. Usado por los flujos de recambio, pedir retiro, alargar retiro y
 * el menú principal (el cliente elige entre SUS contenedores, no cualquiera).
 *
 * `contenedores.estado = 'entregado'` es la fuente de verdad de "lo tiene
 * ahora" — el join contra `viajes` es solo para sacarle la zona/dirección a
 * esa entrega. Por eso NO se filtra por `viajes.estado IN
 * ('programado','en_curso')`: un operador puede marcar esa fila como
 * 'completado' desde el panel (Viajes > Estado) una vez confirmada la
 * entrega, y antes eso hacía desaparecer al contenedor de acá — dejaba sin
 * efecto recambio/retiro/alargar retiro y el menú reducido para ese cliente
 * sin ningún error visible. Solo se descarta 'cancelado' (entrega que nunca pasó).
 */
export async function contenedoresDelCliente(telefono: string): Promise<ContenedorCliente[]> {
  return query<ContenedorCliente>(
    `SELECT c.numero, ultima.zona, ultima.destino_direccion, ultima.destino_lat, ultima.destino_lng
       FROM contenedores c
       CROSS JOIN LATERAL (
         SELECT v.zona, v.destino_direccion, v.destino_lat, v.destino_lng, v.cliente_telefono
           FROM viajes v
          WHERE v.contenedor_numero = c.numero AND v.tipo = 'entrega' AND v.estado <> 'cancelado'
          ORDER BY v.creado_en DESC LIMIT 1
       ) ultima
      WHERE c.estado = 'entregado' AND ultima.cliente_telefono = $1
      ORDER BY c.numero`,
    [telefono],
  );
}
