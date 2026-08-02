import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './components/Toast';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Pagos } from './pages/Pagos';
import { Alertas } from './pages/Alertas';
import { Choferes } from './pages/Choferes';
import { Viajes } from './pages/Viajes';
import { Reportes } from './pages/Reportes';
import { Contenedores } from './pages/Contenedores';

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
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
                      <Route path="/choferes"      element={<Choferes />} />
                      <Route path="/contenedores"  element={<Contenedores />} />
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
