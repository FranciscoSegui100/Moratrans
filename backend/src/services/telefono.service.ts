/**
 * Normalización de números móviles argentinos para WhatsApp.
 *
 * Meta usa dos formatos distintos para el mismo número:
 *  - Formato "wa_id" (el que llega en los webhooks y el que guardamos en DB):
 *    549 + código de área + abonado. Ej: 5492612062258.
 *  - Formato "clásico" (el único que acepta el endpoint de ENVÍO para
 *    números argentinos): 54 + código de área + 15 + abonado.
 *    Ej: 54261152062258. Enviar con el formato wa_id da (#131030).
 *
 * `normalizarDestinoWhatsApp` convierte wa_id -> clásico (para enviar).
 * `normalizarTelefonoAR` convierte cualquier formato de entrada -> wa_id
 * (para guardar siempre igual en choferes.telefono, sin importar cómo lo
 * haya tipeado el operador).
 */

// Códigos de área argentinos de 3 dígitos más comunes (lista no exhaustiva:
// cubre las ciudades principales; códigos de 4 dígitos de localidades chicas
// no están cubiertos y quedan sin transformar).
const NDC_AR_3 = [
  '220', '221', '223', '230', '236', '237', '249', '260', '261', '262', '263',
  '264', '266', '280', '291', '292', '294', '297', '298', '299', '336', '341',
  '342', '343', '345', '348', '351', '353', '358', '362', '364', '370', '376',
  '379', '380', '381', '383', '385', '387', '388',
];

function detectarNdc(resto: string): string | undefined {
  return resto.startsWith('11') ? '11' : NDC_AR_3.find((c) => resto.startsWith(c));
}

/**
 * wa_id (549...) -> formato clásico (54 + área + 15 + abonado), requerido
 * por el endpoint de envío. Si no es un wa_id argentino, no toca el número.
 */
export function normalizarDestinoWhatsApp(numero: string): string {
  if (!numero.startsWith('549')) return numero;
  const resto = numero.slice(3); // código de área + número, sin el '9'
  const ndc = detectarNdc(resto);
  if (!ndc) return numero;
  return `54${ndc}15${resto.slice(ndc.length)}`;
}

/**
 * Cualquier formato de entrada (con o sin +54, con o sin 9, con o sin el
 * viejo prefijo 15, con espacios/guiones/0 inicial) -> wa_id canónico
 * (549 + área + abonado). Es el inverso de `normalizarDestinoWhatsApp`.
 * Si no se reconoce el código de área, igual asegura el prefijo 549.
 */
export function normalizarTelefonoAR(input: string): string {
  let d = input.replace(/\D/g, ''); // solo dígitos
  if (d.startsWith('00')) d = d.slice(2); // 0054...
  else if (d.startsWith('0')) d = d.slice(1); // 0261... (formato local)
  if (!d.startsWith('54')) d = '54' + d;

  let resto = d.slice(2);
  if (resto.startsWith('9')) resto = resto.slice(1);

  // Si quedó el viejo "15" pegado después del código de área, sacarlo.
  const ndc = detectarNdc(resto);
  if (ndc && resto.slice(ndc.length, ndc.length + 2) === '15') {
    resto = ndc + resto.slice(ndc.length + 2);
  }

  return `549${resto}`;
}
