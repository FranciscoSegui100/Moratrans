import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ShieldOff, KeyRound, RotateCcw, Smartphone, Mail } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

export function Seguridad() {
  const { user, logout } = useAuth();
  const { show } = useToast();
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function regenerarCodigos() {
    const password = prompt('Ingresá tu contraseña actual para regenerar los códigos de respaldo:');
    if (!password) return;
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/mfa/backup-codes/regenerar', { password });
      setBackupCodes(data.codigosRespaldo);
    } catch (err: any) {
      show('error', 'No se pudo regenerar', err.response?.data?.error);
    } finally {
      setLoading(false);
    }
  }

  async function desactivarMfa() {
    if (!confirm('Esto desactiva la verificación en dos pasos de tu cuenta. ¿Seguro?')) return;
    const password = prompt('Ingresá tu contraseña actual para confirmar:');
    if (!password) return;
    setLoading(true);
    try {
      await api.post('/api/auth/mfa/desactivar', { password });
      show('success', 'Verificación en dos pasos desactivada');
      logout();
    } catch (err: any) {
      show('error', 'No se pudo desactivar', err.response?.data?.error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Seguridad</h2>
        <p>Verificación en dos pasos de tu cuenta ({user?.email})</p>
      </div>

      <div className="form-card">
        {user?.mfaEnabled ? (
          <>
            <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldCheck strokeWidth={1.75} size={18} /> Verificación en dos pasos
            </div>
            <p className="text-muted" style={{ fontSize: '0.85rem' }}>
              Activa, por {user.mfaMetodo === 'email' ? 'email' : 'app de autenticación'} — se pide un código
              extra en cada inicio de sesión.
            </p>

            {backupCodes ? (
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px',
                fontFamily: 'monospace', fontSize: '0.9rem', background: 'var(--bg-subtle, #f3f4f6)',
                padding: '16px', borderRadius: '8px', margin: '16px 0',
              }}>
                {backupCodes.map((c) => <div key={c}>{c}</div>)}
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button className="btn btn-ghost btn-sm" disabled={loading} onClick={regenerarCodigos}>
                <RotateCcw strokeWidth={1.75} /> Regenerar códigos de respaldo
              </button>
              <button className="btn btn-ghost btn-sm" disabled={loading} onClick={desactivarMfa}>
                <KeyRound strokeWidth={1.75} /> Desactivar
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldOff strokeWidth={1.75} size={18} /> Verificación en dos pasos
            </div>
            <p className="text-muted" style={{ fontSize: '0.85rem' }}>
              No está activada. Es opcional: si querés, podés sumar un código extra a tu contraseña,
              con el método que prefieras.
            </p>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <Link to="/seguridad/activar-verificacion-email" className="btn btn-primary btn-sm">
                <Mail strokeWidth={1.75} /> Por email (más simple)
              </Link>
              <Link to="/seguridad/activar-verificacion" className="btn btn-ghost btn-sm">
                <Smartphone strokeWidth={1.75} /> Con una app
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
