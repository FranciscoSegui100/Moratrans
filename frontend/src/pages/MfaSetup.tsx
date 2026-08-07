import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';

/** Alta opcional de MFA (ver "Seguridad"). Nadie está obligado a pasar por acá para usar el panel. */
export function MfaSetup() {
  const { user, establecerUsuario } = useAuth();
  const nav = useNavigate();
  const [qr, setQr] = useState<string | null>(null);
  const [secreto, setSecreto] = useState('');
  const [codigo, setCodigo] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cargandoQr, setCargandoQr] = useState(true);

  useEffect(() => {
    api.post('/api/auth/mfa/setup/iniciar')
      .then(({ data }) => { setQr(data.qr); setSecreto(data.secreto); })
      .catch(() => setError('No se pudo generar el código QR. Recargá la página.'))
      .finally(() => setCargandoQr(false));
  }, []);

  async function onConfirmar(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/mfa/setup/confirmar', { code: codigo.trim() });
      setBackupCodes(data.codigosRespaldo);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Código inválido');
    } finally {
      setLoading(false);
    }
  }

  function terminar() {
    if (user) establecerUsuario({ ...user, mfaEnabled: true, mfaMetodo: 'totp' });
    nav('/seguridad');
  }

  if (backupCodes) {
    return (
      <div className="login-page">
        <div className="login-card" style={{ maxWidth: '480px' }}>
          <div className="login-logo">
            <div className="login-logo-mark">MT</div>
            <h1>Moratrans</h1>
            <p>Guardá tus códigos de respaldo</p>
          </div>
          <p style={{ fontSize: '0.85rem' }}>
            Si perdés el celular con tu app de autenticación, estos son los únicos códigos que te van a
            permitir entrar. Cada uno sirve una sola vez. Guardalos en un lugar seguro — no se van a
            volver a mostrar.
          </p>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px',
            fontFamily: 'monospace', fontSize: '0.9rem', background: 'var(--bg-subtle, #f3f4f6)',
            padding: '16px', borderRadius: '8px', margin: '16px 0',
          }}>
            {backupCodes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <button className="btn btn-primary" style={{ justifyContent: 'center', padding: '10px', width: '100%' }} onClick={terminar}>
            Ya los guardé, continuar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card" style={{ maxWidth: '480px' }}>
        <div className="login-logo">
          <div className="login-logo-mark">MT</div>
          <h1>Moratrans</h1>
          <p>Activá la verificación en dos pasos</p>
        </div>
        <p style={{ fontSize: '0.85rem', textAlign: 'center' }}>
          Es opcional. Si querés sumar un paso más de seguridad a tu cuenta, escaneá el código con
          Google Authenticator, Authy, o cualquier app compatible con TOTP.
        </p>

        {cargandoQr && <p style={{ textAlign: 'center' }}>Generando código...</p>}
        {qr && (
          <div style={{ textAlign: 'center', margin: '16px 0' }}>
            <img src={qr} alt="Código QR para configurar MFA" style={{ width: '200px', height: '200px' }} />
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '8px' }}>
              ¿No podés escanear? Ingresá este código a mano: <br />
              <code>{secreto}</code>
            </p>
          </div>
        )}

        <form onSubmit={onConfirmar} className="login-form">
          <div className="form-group">
            <label className="form-label">Código de 6 dígitos</label>
            <input
              className="form-input"
              type="text"
              inputMode="numeric"
              placeholder="123456"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              autoFocus
              required
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '10px' }} disabled={loading || !qr}>
            {loading ? 'Verificando...' : 'Activar'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '18px', fontSize: '0.82rem' }}>
          <Link to="/seguridad">Cancelar</Link>
        </p>
      </div>
    </div>
  );
}
