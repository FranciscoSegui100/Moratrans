export interface ParadaParaAviso {
  cliente_telefono: string | null;
  grupo_id: string | null;
  tipo: 'entrega' | 'retiro';
  destino_direccion: string | null;
}

export interface AvisoConfirmacion {
  clienteTelefono: string;
  tipo: 'entrega' | 'retiro' | 'recambio';
  destinoDireccion: string | null;
  fecha: string;
}

/**
 * Procesa la lista de paradas confirmadas en una ruta y genera la lista deduplicada
 * de avisos que deben enviarse por WhatsApp a los clientes.
 *
 * Reglas de negocio:
 * 1. Si dos paradas comparten `grupo_id`, corresponden a un RECAMBIO (entrega + retiro)
 *    y se deben consolidar en un ÚNICO aviso con `tipo: 'recambio'`.
 * 2. Deduplica avisos idénticos al mismo teléfono, dirección y tipo para no spamear.
 * 3. Ignora paradas que no tengan teléfono de cliente asociado.
 */
export function calcularAvisosConfirmacion(
  paradas: ParadaParaAviso[],
  fecha: string,
): AvisoConfirmacion[] {
  const gruposAvisados = new Set<string>();
  const avisados = new Set<string>();
  const avisos: AvisoConfirmacion[] = [];

  for (const v of paradas) {
    if (!v.cliente_telefono) continue;
    const esRecambio = Boolean(v.grupo_id);
    if (esRecambio) {
      if (gruposAvisados.has(v.grupo_id!)) continue;
      gruposAvisados.add(v.grupo_id!);
    }
    const tipoAviso: 'entrega' | 'retiro' | 'recambio' = esRecambio ? 'recambio' : v.tipo;
    const clave = `${v.cliente_telefono}|${(v.destino_direccion || '').trim().toLowerCase()}|${tipoAviso}`;
    if (avisados.has(clave)) continue;
    avisados.add(clave);

    avisos.push({
      clienteTelefono: v.cliente_telefono,
      tipo: tipoAviso,
      destinoDireccion: v.destino_direccion,
      fecha,
    });
  }

  return avisos;
}
