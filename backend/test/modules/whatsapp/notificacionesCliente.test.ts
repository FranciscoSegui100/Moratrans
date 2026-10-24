import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as graphApi from '../../../src/modules/whatsapp/graphApi';
import {
  notificarClientePedidoConfirmado,
  notificarClienteChoferEnCamino,
  notificarClienteServicioFinalizado,
} from '../../../src/modules/whatsapp/notificacionesCliente';

vi.mock('../../../src/modules/whatsapp/graphApi', () => ({
  sendText: vi.fn().mockResolvedValue({}),
  sendButtons: vi.fn().mockResolvedValue({}),
  motivoErrorWa: vi.fn((e: any) => e?.message ?? 'error'),
}));

describe('notificacionesCliente (QA Suite)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('notificarClientePedidoConfirmado', () => {
    it('notifica confirmación de ENTREGA correctamente con fecha', async () => {
      await notificarClientePedidoConfirmado({
        clienteTelefono: '+5492615551234',
        tipo: 'entrega',
        destinoDireccion: 'San Martín 500',
        fecha: '2026-10-30',
      });

      expect(graphApi.sendText).toHaveBeenCalledTimes(1);
      const [tel, mensaje] = vi.mocked(graphApi.sendText).mock.calls[0];
      expect(tel).toBe('+5492615551234');
      expect(mensaje).toContain('Tu pedido quedó confirmado');
      expect(mensaje).toContain('📍 *Destino:* San Martín 500');
      expect(mensaje).toContain('coordinar la entrega el día');
      expect(mensaje).toContain('viernes 30 de octubre');
    });

    it('notifica confirmación de RETIRO correctamente', async () => {
      await notificarClientePedidoConfirmado({
        clienteTelefono: '+5492615551234',
        tipo: 'retiro',
        destinoDireccion: 'Belgrano 120',
        fecha: '2026-10-30',
      });

      expect(graphApi.sendText).toHaveBeenCalledTimes(1);
      const [, mensaje] = vi.mocked(graphApi.sendText).mock.calls[0];
      expect(mensaje).toContain('coordinar el retiro el día');
    });

    it('notifica confirmación de RECAMBIO unificado (nunca como entrega o retiro suelto)', async () => {
      await notificarClientePedidoConfirmado({
        clienteTelefono: '+5492615551234',
        tipo: 'recambio',
        destinoDireccion: 'Laguna del Rosario 1123',
        fecha: '2026-10-30',
      });

      expect(graphApi.sendText).toHaveBeenCalledTimes(1);
      const [, mensaje] = vi.mocked(graphApi.sendText).mock.calls[0];
      expect(mensaje).toContain('coordinar el recambio el día');
      expect(mensaje).not.toContain('coordinar la entrega');
    });

    it('no intenta enviar mensaje si clienteTelefono es null o vacío', async () => {
      await notificarClientePedidoConfirmado({
        clienteTelefono: null,
        tipo: 'recambio',
        destinoDireccion: 'Laguna del Rosario 1123',
        fecha: '2026-10-30',
      });

      expect(graphApi.sendText).not.toHaveBeenCalled();
    });
  });

  describe('notificarClienteChoferEnCamino', () => {
    it('notifica chofer en camino para RECAMBIO con chofer, patente y contenedor', async () => {
      await notificarClienteChoferEnCamino({
        clienteTelefono: '+5492615551234',
        tipo: 'recambio',
        destinoDireccion: 'Perú 800',
        choferNombre: 'Carlos Gómez',
        patente: 'AF123JK',
        contenedorNumero: 'C-042',
      });

      expect(graphApi.sendText).toHaveBeenCalledTimes(1);
      const [, mensaje] = vi.mocked(graphApi.sendText).mock.calls[0];
      expect(mensaje).toContain('hacer el recambio de tu contenedor');
      expect(mensaje).toContain('Carlos Gómez');
      expect(mensaje).toContain('AF123JK');
      expect(mensaje).toContain('C-042');
      expect(mensaje).toContain('Perú 800');
    });

    it('notifica chofer en camino para ENTREGA y RETIRO', async () => {
      await notificarClienteChoferEnCamino({
        clienteTelefono: '+5492615551234',
        tipo: 'entrega',
        destinoDireccion: 'Colon 400',
        choferNombre: null,
        patente: null,
        contenedorNumero: null,
      });

      const [, msgEntrega] = vi.mocked(graphApi.sendText).mock.calls[0];
      expect(msgEntrega).toContain('entregar tu contenedor');

      await notificarClienteChoferEnCamino({
        clienteTelefono: '+5492615551234',
        tipo: 'retiro',
        destinoDireccion: 'Colon 400',
        choferNombre: null,
        patente: null,
        contenedorNumero: null,
      });

      const [, msgRetiro] = vi.mocked(graphApi.sendText).mock.calls[1];
      expect(msgRetiro).toContain('retirar el contenedor');
    });
  });

  describe('notificarClienteServicioFinalizado', () => {
    it('envía encuesta de satisfacción para RECAMBIO con título apropiado y 3 botones', async () => {
      await notificarClienteServicioFinalizado({
        clienteTelefono: '+5492615551234',
        tipo: 'recambio',
        contenedorNumero: 'C-099',
      });

      expect(graphApi.sendButtons).toHaveBeenCalledTimes(1);
      const [tel, cuerpo, botones] = vi.mocked(graphApi.sendButtons).mock.calls[0];
      expect(tel).toBe('+5492615551234');
      expect(cuerpo).toContain('¡Tu recambio de contenedor fue realizado! 🔄');
      expect(cuerpo).toContain('C-099');
      expect(botones).toHaveLength(3);
      expect(botones[0].id).toBe('encuesta_5');
      expect(botones[1].id).toBe('encuesta_3');
      expect(botones[2].id).toBe('encuesta_1');
    });

    it('envía encuesta para ENTREGA y RETIRO con sus emojis respectivos', async () => {
      await notificarClienteServicioFinalizado({
        clienteTelefono: '+5492615551234',
        tipo: 'entrega',
        contenedorNumero: 'C-010',
      });
      const [, cuerpoEntrega] = vi.mocked(graphApi.sendButtons).mock.calls[0];
      expect(cuerpoEntrega).toContain('¡Tu contenedor fue entregado! 📦');

      await notificarClienteServicioFinalizado({
        clienteTelefono: '+5492615551234',
        tipo: 'retiro',
        contenedorNumero: 'C-010',
      });
      const [, cuerpoRetiro] = vi.mocked(graphApi.sendButtons).mock.calls[1];
      expect(cuerpoRetiro).toContain('¡Tu contenedor fue retirado con éxito! 📥');
    });
  });
});
