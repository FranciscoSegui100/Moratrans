import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

const ALERTAS_KEY = ['alertas'];

/** Carga las alertas abiertas (cacheadas, instantáneas al revisitar la pestaña) y las mantiene actualizadas por Socket.io. */
export function useAlertas() {
  const queryClient = useQueryClient();
  const { data: alertas = [] } = useQuery<Alerta[]>({
    queryKey: ALERTAS_KEY,
    queryFn: () => api.get<Alerta[]>('/api/alertas').then((r) => r.data),
  });

  useEffect(() => {
    const socket = conectarSocket();
    // Resincroniza al (re)conectar para no perder alertas creadas durante
    // un corte de red o mientras la pestaña estaba en segundo plano.
    const resincronizar = () => queryClient.invalidateQueries({ queryKey: ALERTAS_KEY });
    socket.on('connect', resincronizar);
    socket.on('nueva_alerta', (a: Alerta) => {
      queryClient.setQueryData<Alerta[]>(ALERTAS_KEY, (prev = []) =>
        prev.find((x) => x.id === a.id) ? prev : [a, ...prev]);
    });
    return () => {
      socket.off('connect', resincronizar);
      socket.off('nueva_alerta');
    };
  }, [queryClient]);

  async function resolver(id: string) {
    await api.patch(`/api/alertas/${id}`, { estado: 'resuelta' });
    queryClient.setQueryData<Alerta[]>(ALERTAS_KEY, (prev = []) => prev.filter((a) => a.id !== id));
  }

  /** Quita del listado la alerta cuyo (tipo, referencia_id) coincide (usado tras resolver una acción). */
  function quitarAlerta(tipo: string, referenciaId: string) {
    queryClient.setQueryData<Alerta[]>(ALERTAS_KEY, (prev = []) =>
      prev.filter((a) => !(a.tipo === tipo && a.referencia_id === referenciaId)));
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
