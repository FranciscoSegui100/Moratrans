import { BrowserRouter, Routes, Route } from 'react-router-dom';
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
import { PideAsesoria } from './pages/PideAsesoria';
import { Choferes } from './pages/Choferes';
import { Viajes } from './pages/Viajes';
import { Reportes } from './pages/Reportes';
import { Contenedores } from './pages/Contenedores';
import { Tarifas } from './pages/Tarifas';
import { Usuarios } from './pages/Usuarios';
import { Seguridad } from './pages/Seguridad';
import { MfaSetup } from './pages/MfaSetup';
import { MfaSetupEmail } from './pages/MfaSetupEmail';
import { Auditoria } from './pages/Auditoria';

export default function App() {
  return (
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
                      <Route path="/alertas"       element={<Alertas />} />
                      <Route path="/asesoria"      element={<PideAsesoria />} />
                      <Route path="/choferes"      element={<Choferes />} />
                      <Route path="/contenedores"  element={<Contenedores />} />
                      <Route path="/tarifas"       element={<Tarifas />} />
                      <Route path="/usuarios"      element={<Usuarios />} />
                      <Route path="/seguridad"     element={<Seguridad />} />
                      <Route path="/auditoria"     element={<Auditoria />} />
                      <Route path="/reportes"      element={<Reportes />} />
                    </Routes>
                  </Layout>
                </ProtectedRoute>
              }
            />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
