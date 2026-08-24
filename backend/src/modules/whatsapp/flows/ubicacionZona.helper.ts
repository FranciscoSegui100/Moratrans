import { query } from '../../../config/db';
import { sendText, sendList, sendLocationRequest } from '../graphApi';
import { estaDentroDeDepartamento, detectarDepartamento, distanciaALaBaseMasCercana } from '../../../services/geoDepartamento.service';
import { forwardGeocode, CandidatoDireccion } from '../../../services/geocoding.service';
import { obtenerOCrearCliente } from '../../../services/clientes.service';
import { escalarAAsesor } from './asesor.flow';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

/**
 * Capas 2 y 3 de la verificación de ubicación (ver cotizacion.flow.ts):
 *  - Capa 2: valida las coordenadas GPS contra el polígono del departamento
 *    (si se pasa `departamentoEsperado`, ya elegido por el cliente) o lo
 *    autodetecta si no hay uno esperado.
 *  - Capa 3: si el punto no cae en NINGÚN departamento conocido, nunca se
 *    inventa un precio — se registra el pedido en estado 'fuera_de_zona' y
 *    se deriva a un asesor.
 * Compartida por cotización, recambio (dirección nueva) y cuenta corriente.
 * La capa 4 (confirmación explícita "¿es el destino?") queda a criterio de
 * cada flujo — acá no se manda ningún mensaje de confirmación.
 */

export interface ContextoPedidoFueraDeZona {
  tipo?: 'entrega' | 'recambio';
  contenedorRecambioNumero?: string | null;
  departamentoOriginal?: string | null;
}

/** Capa 3 en crudo: registra el pedido 'fuera_de_zona' y escala a un asesor. */
export async function manejarFueraDeZona(
  m: MensajeEntrante,
  sesion: Sesion,
  destinoLat: number,
  destinoLng: number,
  destinoDireccion: string | null,
  contextoPedido: ContextoPedidoFueraDeZona = {},
): Promise<void> {
  const to = m.from;
  const { tipo = 'entrega', contenedorRecambioNumero = null, departamentoOriginal = null } = contextoPedido;
  const distancia = await distanciaALaBaseMasCercana(destinoLat, destinoLng);

  const [pedido] = await query<{ numero_pedido: number }>(
    `INSERT INTO pedidos (cliente_telefono, cliente_nombre, zona, estado, destino_lat, destino_lng, destino_direccion, tipo, contenedor_recambio_numero)
     VALUES ($1,$2,$3,'fuera_de_zona',$4,$5,$6,$7,$8) RETURNING numero_pedido`,
    [to, m.nombrePerfil ?? null, departamentoOriginal ?? 'sin_zona', destinoLat, destinoLng, destinoDireccion, tipo, contenedorRecambioNumero],
  );
  obtenerOCrearCliente(to, m.nombrePerfil).catch((e) => console.error('Error dando de alta al cliente:', e));

  await sendText(
    to,
    `📍 Tu ubicación está fuera de las zonas que cubrimos hoy` +
      (distancia ? ` (a unos *${distancia.distanciaKm} km* de ${distancia.nombre}).` : '.') +
      `\n\nAnotamos tu pedido *#${pedido.numero_pedido}* — un asesor lo va a revisar para ver si podemos coordinarlo igual.`,
  );
  await escalarAAsesor(to, sesion, `${to} pidió un contenedor fuera de zona (pedido #${pedido.numero_pedido})`);
}

export type ResultadoVerificacionZona =
  | { ok: true; departamento: string; mismatchCon?: string; tarifa: { precio: string; moneda: string } | null }
  | { ok: false };

/**
 * Corre capas 2 y 3 completas a partir de un GPS ya recibido.
 *  - Si `departamentoEsperado` no viene: autodetecta el departamento; si no
 *    cae en ninguno -> fuera de zona (ya respondido, `ok:false`).
 *  - Si `departamentoEsperado` viene y el punto SÍ cae ahí: usa ese.
 *  - Si `departamentoEsperado` viene y el punto NO cae ahí: si cae en otro
 *    departamento conocido, devuelve `mismatchCon` para que el caller decida
 *    qué hacer (cotización le pregunta al cliente cuál es el correcto); si
 *    no cae en ninguno -> fuera de zona.
 *  - `requiereTarifa`: si el flujo necesita mostrar/cobrar un precio (cotización,
 *    recambio), exige tarifa activa en la zona detectada — si no hay, avisa y
 *    devuelve `ok:false` (cuenta corriente no cobra acá, así que no la exige).
 */
export async function verificarUbicacionCompleta(
  m: MensajeEntrante,
  sesion: Sesion,
  lat: number,
  lng: number,
  destinoDireccion: string | null,
  opciones: {
    departamentoEsperado?: string;
    requiereTarifa?: boolean;
    contextoPedidoFueraDeZona?: ContextoPedidoFueraDeZona;
  } = {},
): Promise<ResultadoVerificacionZona> {
  const to = m.from;
  const { departamentoEsperado, requiereTarifa = false, contextoPedidoFueraDeZona } = opciones;

  let departamento: string | null;
  let mismatchCon: string | undefined;

  if (departamentoEsperado) {
    const dentro = await estaDentroDeDepartamento(lat, lng, departamentoEsperado);
    if (dentro !== false) {
      // true (cae adentro) o null (ese departamento no tiene polígono cargado, no bloquea)
      departamento = departamentoEsperado;
    } else {
      const detectado = await detectarDepartamento(lat, lng);
      if (!detectado) {
        await manejarFueraDeZona(m, sesion, lat, lng, destinoDireccion, {
          ...contextoPedidoFueraDeZona,
          departamentoOriginal: departamentoEsperado,
        });
        return { ok: false };
      }
      departamento = departamentoEsperado;
      mismatchCon = detectado;
    }
  } else {
    departamento = await detectarDepartamento(lat, lng);
    if (!departamento) {
      await manejarFueraDeZona(m, sesion, lat, lng, destinoDireccion, contextoPedidoFueraDeZona);
      return { ok: false };
    }
  }

  if (!requiereTarifa) {
    return { ok: true, departamento, mismatchCon, tarifa: null };
  }

  const [tarifa] = await query<{ precio: string; moneda: string }>(
    'SELECT precio, moneda FROM tarifas_departamento WHERE departamento = $1 AND activo = TRUE',
    [departamento],
  );
  if (!tarifa) {
    await sendLocationRequest(
      to,
      `🙁 Detectamos tu ubicación en *${departamento}*, pero no tenemos tarifa activa ahí todavía. Volvé a compartir tu ubicación, o escribí *asesor* para coordinarlo.`,
    );
    return { ok: false };
  }

  return { ok: true, departamento, mismatchCon, tarifa };
}

export type ResultadoDireccionTexto =
  | { tipo: 'sin_resultados' }
  | { tipo: 'un_candidato'; candidato: CandidatoDireccion }
  | { tipo: 'varios_candidatos'; candidatos: CandidatoDireccion[] };

/**
 * Dirección escrita por el cliente -> candidatos con coordenadas (Nominatim).
 * El pin GPS sigue siendo más preciso, pero el candidato geocodificado ya
 * trae lat/lng utilizables: el caller puede pasarlo directo a
 * `verificarUbicacionCompleta` y avanzar a la capa 4, sin obligar a mandar
 * el pin — hay dispositivos que no dejan compartir ubicación (regla del
 * dueño: dar siempre las dos opciones, texto o pin).
 */
export async function buscarCandidatosDireccion(texto: string): Promise<ResultadoDireccionTexto> {
  const candidatos = await forwardGeocode(texto.trim());
  if (candidatos.length === 0) return { tipo: 'sin_resultados' };
  if (candidatos.length === 1) return { tipo: 'un_candidato', candidato: candidatos[0] };
  return { tipo: 'varios_candidatos', candidatos };
}

export async function enviarListaCandidatos(to: string, candidatos: CandidatoDireccion[]): Promise<void> {
  await sendList(
    to,
    '📍 ¿Cuál es?',
    'Encontramos varias direcciones parecidas — elegí la que corresponda:',
    'Ver direcciones',
    candidatos.map((c, i) => ({ id: `cand:${i}`, title: c.direccion.slice(0, 24) })),
  );
}

/** Extrae el candidato elegido de una respuesta `cand:<idx>` contra la lista guardada en el contexto. */
export function elegirCandidato(m: MensajeEntrante, candidatos: CandidatoDireccion[]): CandidatoDireccion | null {
  if (!m.seleccionId?.startsWith('cand:')) return null;
  const idx = Number(m.seleccionId.replace('cand:', ''));
  return candidatos[idx] ?? null;
}

/**
 * Mensaje estándar para pedir la ubicación de entrega: da siempre las dos
 * opciones (pin GPS o dirección escrita) y, si escribe, pide explícitamente
 * calle + número + zona/departamento — sin esto, "Chile 1120" sin más datos
 * geocodifica mal o ambiguo. El pin sigue siendo la opción más precisa.
 */
export function mensajePedirUbicacion(pregunta: string): string {
  return (
    `${pregunta}\n\n` +
    `Tocá "Enviar ubicación" para mandar el pin GPS (la opción más precisa), ` +
    `o escribime la dirección con calle, número y zona/departamento.\n` +
    `Ej: _Av. San Martín 1234, Godoy Cruz_.`
  );
}

/** Aviso que se suma en la capa 4 cuando la ubicación viene de texto geocodificado, no de un pin real. */
export const AVISO_DIRECCION_APROXIMADA =
  '🔎 Esta ubicación es aproximada (la calculamos a partir de la dirección que escribiste). ' +
  'Si preferís más precisión, tocá "↩️ Mandar otra" y compartí el pin GPS.';
