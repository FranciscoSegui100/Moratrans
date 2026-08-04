import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { conectarSocket } from '../api/socket';
import type { ValidarPagoPayload } from '../components/ValidarPagoForm';

export interface Alerta {
  id: string;
  tipo: string;
  referencia_id: string;
  mensaje: string;
  estado: string;
  creado_en: string;
  // Presentes sólo en alertas de tipo 'pago_pendiente_validacion'.
  cliente_telefono?: string | null;
  monto?: string | null;
  pago_estado?: string | null;
  tiene_comprobante?: boolean | null;
  zona?: string | null;
  precio?: string | null;
  moneda?: string | null;
}

/** Carga las alertas abiertas y las mantiene actualizadas por Socket.io. */
export function useAlertas() {
  const [alertas, setAlertas] = useState<Alerta[]>([]);

  useEffect(() => {
    api.get<Alerta[]>('/api/alertas').then((r) => setAlertas(r.data)).catch(() => {});

    const socket = conectarSocket();
    socket.on('nueva_alerta', (a: Alerta) => {
      setAlertas((prev) => (prev.find((x) => x.id === a.id) ? prev : [a, ...prev]));
    });
    return () => { socket.off('nueva_alerta'); };
  }, []);

  async function resolver(id: string) {
    await api.patch(`/api/alertas/${id}`, { estado: 'resuelta' });
    setAlertas((prev) => prev.filter((a) => a.id !== id));
  }

  /** Quita del listado la alerta cuyo (tipo, referencia_id) coincide (usado tras resolver una acción). */
  function quitarAlerta(tipo: string, referenciaId: string) {
    setAlertas((prev) => prev.filter((a) => !(a.tipo === tipo && a.referencia_id === referenciaId)));
  }

  /** Valida el pago (el backend resuelve la alerta de forma atómica junto con la reserva). */
  async function validarPago(pagoId: string, payload: ValidarPagoPayload = {}) {
    const { data } = await api.post(`/api/pagos/${pagoId}/validar`, payload);
    quitarAlerta('pago_pendiente_validacion', pagoId);
    return data as { ticket_id: string; contenedor: string };
  }

  /** Rechaza el pago (el backend resuelve la alerta y avisa al cliente por WhatsApp). */
  async function rechazarPago(pagoId: string, motivo: string) {
    await api.post(`/api/pagos/${pagoId}/rechazar`, { motivo });
    quitarAlerta('pago_pendiente_validacion', pagoId);
  }

  /** El operador confirma que el contenedor retirado por un chofer llegó a la empresa. */
  async function confirmarRetiro(numeroContenedor: string) {
    await api.post(`/api/contenedores/${encodeURIComponent(numeroContenedor)}/confirmar-retiro`);
    quitarAlerta('confirmar_retiro', numeroContenedor);
  }

  /** Sube la factura pedida por el cliente y se la reenvía por WhatsApp. */
  async function enviarFactura(pagoId: string, archivo: File) {
    await api.post(`/api/pagos/${pagoId}/factura`, archivo, {
      headers: { 'Content-Type': archivo.type || 'application/octet-stream' },
      params: { filename: archivo.name },
    });
    quitarAlerta('factura_solicitada', pagoId);
  }

  return { alertas, resolver, validarPago, rechazarPago, confirmarRetiro, enviarFactura };
}
