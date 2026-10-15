/**
 * Etiquetas legibles, descripciones y sectorización por tipo de alerta.
 * Usado en el sidebar, notificaciones toast y la vista sectorizada de Alertas.
 */

export const tipoLabel: Record<string, string> = {
  pago_pendiente_validacion:  'Pago pendiente de validación',
  pago_vencido:               'Pago vencido',
  cuenta_corriente_solicitada: 'Pago a cuenta corriente',
  alargue_solicitado:         'Pide alargar el retiro',
  factura_solicitada:         'Pide factura',
  contenedor_por_vencer:      'Contenedor por vencer',
  confirmar_retiro:           'Confirmar llegada de contenedor',
  retiro_solicitado:          'Pide que retiren un contenedor',
  recambio_solicitado:        'Pide un recambio',
  entrega_solicitada:         'Pide entrega de contenedor',
  stock_bajo:                 'Stock bajo de contenedores',
  solicita_asesor:            'Pide hablar con un asesor',
  chofer_no_reconocido:       'Chofer no reconocido',
  chofer_cambio_telefono:     'Cambio de teléfono de chofer',
  envio_fallido:              'No se pudo enviar un WhatsApp',
};

export const tipoDescripcion: Record<string, string> = {
  pago_pendiente_validacion:  'Comprobantes de transferencia o efectivo pendientes de aprobación contable',
  pago_vencido:               'Pedidos o alquileres cuyo plazo estipulado de pago ha vencido',
  cuenta_corriente_solicitada: 'Clientes autorizados que cargaron el servicio a su saldo de cuenta corriente',
  alargue_solicitado:         'Clientes que solicitaron extender días de alquiler de su contenedor',
  factura_solicitada:         'Solicitudes de emisión de factura comercial o comprobante fiscal',
  contenedor_por_vencer:      'Contenedores en cliente próximos a la fecha pactada de retiro (aviso 48h / 24h)',
  confirmar_retiro:           'Chofer en destino esperando confirmación de retiro y recepción física',
  retiro_solicitado:          'El cliente terminó la obra y solicita que pasen a retirar el contenedor',
  recambio_solicitado:        'El cliente solicita vaciar o sustituir el contenedor actual por uno vacío',
  entrega_solicitada:         'Nuevas solicitudes de entrega de contenedor por cuenta corriente',
  stock_bajo:                 'Cantidad de contenedores libres por debajo del umbral operativo mínimo',
  solicita_asesor:            'Clientes en WhatsApp solicitando atención personalizada o consultas de catálogo',
  chofer_no_reconocido:       'Mensajes entrantes de choferes o líneas no registradas en la flota',
  chofer_cambio_telefono:     'Notificaciones de choferes informando una nueva línea telefónica activa',
  envio_fallido:              'Fallos en la entrega de mensajes o plantillas salientes de WhatsApp',
};

export type SectorId = 'todos' | 'pagos' | 'logistica' | 'asesor' | 'choferes' | 'sistema';

export interface SectorMeta {
  id: SectorId;
  label: string;
  badgeClass: string;
  color: string;
  tipos: string[];
}

export const SECTORES: SectorMeta[] = [
  {
    id: 'todos',
    label: 'Todas',
    badgeClass: 'badge-todos',
    color: 'var(--text-primary)',
    tipos: [],
  },
  {
    id: 'pagos',
    label: 'Pagos y Finanzas',
    badgeClass: 'badge-pagos',
    color: 'var(--accent)',
    tipos: [
      'pago_pendiente_validacion',
      'pago_vencido',
      'cuenta_corriente_solicitada',
      'alargue_solicitado',
      'factura_solicitada',
    ],
  },
  {
    id: 'logistica',
    label: 'Contenedores y Logística',
    badgeClass: 'badge-logistica',
    color: 'var(--warning)',
    tipos: [
      'contenedor_por_vencer',
      'confirmar_retiro',
      'retiro_solicitado',
      'recambio_solicitado',
      'entrega_solicitada',
      'stock_bajo',
    ],
  },
  {
    id: 'asesor',
    label: 'Atención al Cliente',
    badgeClass: 'badge-asesor',
    color: 'var(--purple)',
    tipos: ['solicita_asesor'],
  },
  {
    id: 'choferes',
    label: 'Choferes',
    badgeClass: 'badge-choferes',
    color: 'var(--info)',
    tipos: ['chofer_no_reconocido', 'chofer_cambio_telefono'],
  },
  {
    id: 'sistema',
    label: 'Sistema y Envíos',
    badgeClass: 'badge-sistema',
    color: 'var(--danger)',
    tipos: ['envio_fallido'],
  },
];

/** Devuelve la configuración del sector al que pertenece un tipo de alerta determinado. */
export function getSectorDeTipo(tipo: string): SectorMeta {
  const encontrado = SECTORES.find((s) => s.id !== 'todos' && s.tipos.includes(tipo));
  return encontrado ?? SECTORES.find((s) => s.id === 'sistema')!;
}
