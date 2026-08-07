import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';

/** Alta de MFA método "email": alternativa sin apps ni QR, pensada para quien no quiera instalar un authenticator. */
export function MfaSetupEmail() {
  const { user, establecerUsuario } = useAuth();
  const [enviando, setEnviando] = useState(true);
  const [reenviado, setReenviado] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    api.post('/api/auth/mfa/setup/email/enviar')
      .then(() => {})
      .catch(() => setError('No se pudo enviar el código. Probá de nuevo.'))
      .finally(() => setEnviando(false));
  }, []);

  async function onReenviar() {
    setError('');
    setEnviando(true);
    try {
      await api.post('/api/auth/mfa/setup/email/enviar');
      setReenviado(true);
    } catch {
      setError('No se pudo reenviar el código.');
    } finally {
      setEnviando(false);
    }
  }

  async function onConfirmar(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/mfa/setup/email/confirmar', { code: codigo.trim() });
      setBackupCodes(data.codigosRespaldo);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Código inválido');
    } finally {
      setLoading(false);
    }
  }

  function terminar() {
    if (user) establecerUsuario({ ...user, mfaEnabled: true, mfaMetodo: 'email' });
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
            Si en algún momento no podés recibir el email (cambiaste de casilla, por ejemplo), estos códigos son
            la única forma de entrar. Cada uno sirve una sola vez. Guardalos en un lugar seguro.
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
          <p>Activá la verificación por email</p>
        </div>
        <p style={{ fontSize: '0.85rem', textAlign: 'center' }}>
          Te mandamos un código a <strong>{user?.email}</strong>. De ahora en más, cada vez que inicies sesión te
          vamos a pedir un código nuevo por email además de tu contraseña.
        </p>

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

          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {enviando ? 'Enviando...' : reenviado ? 'Te mandamos otro código.' : '¿No te llegó?'}{' '}
            {!enviando && (
              <button type="button" onClick={onReenviar} style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
                Reenviar código
              </button>
            )}
          </p>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '10px' }} disabled={loading}>
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
