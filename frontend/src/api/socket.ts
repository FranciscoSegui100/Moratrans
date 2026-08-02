import { io, Socket } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || '';
let socket: Socket | null = null;

// Conecta el socket autenticado con el mismo JWT del panel.
export function conectarSocket(): Socket {
  const token = localStorage.getItem('token') || '';
  if (socket) socket.disconnect();
  socket = io(API_URL, { auth: { token } });
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}
