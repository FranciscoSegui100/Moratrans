import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './components/Toast';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { ForgotPassword } from './pages/ForgotPassword';
import { SetPassword } from './pages/SetPassword';
import { Dashboard } from './pages/Dashboard';
import { Pagos } from './pages/Pagos';
import { Alertas } from './pages/Alertas';
import { Conversaciones } from './pages/Conversaciones';
import { Choferes } from './pages/Choferes';
import { Clientes } from './pages/Clientes';
import { ClienteDetalle } from './pages/ClienteDetalle';
import { Viajes } from './pages/Viajes';
import { Rutas } from './pages/Rutas';
import { Contenedores } from './pages/Contenedores';
import { Tarifas } from './pages/Tarifas';
import { Ubicaciones } from './pages/Ubicaciones';
import { Usuarios } from './pages/Usuarios';
import { Seguridad } from './pages/Seguridad';
import { MfaSetup } from './pages/MfaSetup';
import { MfaSetupEmail } from './pages/MfaSetupEmail';
import { Auditoria } from './pages/Auditoria';

// Datos ya vistos se muestran al instante desde caché al volver a una
// pestaña (sin esperar el fetch), y se revalidan solos en segundo plano.
// gcTime largo: mantiene esa caché mientras dure la sesión de trabajo.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: true,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<SetPassword titulo="Elegí tu nueva contraseña" />} />
              <Route path="/aceptar-invitacion" element={<SetPassword titulo="Activá tu cuenta" />} />
              <Route
                path="/seguridad/activar-verificacion"
                element={<ProtectedRoute><MfaSetup /></ProtectedRoute>}
              />
              <Route
                path="/seguridad/activar-verificacion-email"
                element={<ProtectedRoute><MfaSetupEmail /></ProtectedRoute>}
              />
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Routes>
                        <Route path="/"             element={<Dashboard />} />
                        <Route path="/pagos"         element={<Pagos />} />
                        <Route path="/viajes"        element={<Viajes />} />
                        <Route path="/rutas"         element={<Rutas />} />
                        <Route path="/alertas"       element={<Alertas />} />
                        <Route path="/conversaciones" element={<Conversaciones />} />
                        <Route path="/choferes"      element={<Choferes />} />
                        <Route path="/clientes"      element={<Clientes />} />
                        <Route path="/clientes/:telefono" element={<ClienteDetalle />} />
                        <Route path="/contenedores"  element={<Contenedores />} />
                        <Route path="/tarifas"       element={<Tarifas />} />
                        <Route path="/ubicaciones"   element={<Ubicaciones />} />
                        <Route path="/usuarios"      element={<Usuarios />} />
                        <Route path="/seguridad"     element={<Seguridad />} />
                        <Route path="/auditoria"     element={<Auditoria />} />
                      </Routes>
                    </Layout>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
