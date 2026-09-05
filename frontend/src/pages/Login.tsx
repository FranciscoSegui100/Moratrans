import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';

export function Login() {
  const { login, verificarMfa } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('admin@empresa.com');
  const [password, setPassword] = useState('');
  const [recordar, setRecordar] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Cuando el usuario tiene MFA activado, /api/auth/login no loguea todavía:
  // devuelve un challengeId y hay que pedir el segundo factor acá mismo.
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [metodoMfa, setMetodoMfa] = useState<'totp' | 'email'>('totp');
  const [codigo, setCodigo] = useState('');
  const [reenviado, setReenviado] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const resultado = await login(email, password, recordar);
      if (resultado.mfaRequired) {
        setChallengeId(resultado.challengeId);
        setMetodoMfa(resultado.metodo);
      } else {
        nav('/');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Email o contraseña incorrectos');
    } finally {
      setLoading(false);
    }
  }

  async function onSubmitMfa(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await verificarMfa(challengeId!, codigo.trim());
      nav('/');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Código inválido');
    } finally {
      setLoading(false);
    }
  }

  async function onReenviar() {
    setError('');
    try {
      await api.post('/api/auth/mfa/reenviar', { challengeId });
      setReenviado(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'No se pudo reenviar el código');
    }
  }

  if (challengeId) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">
            <img src="/logo.png" alt="MoraTrans" className="login-logo-mark" />
            <h1>Moratrans</h1>
            <p>Verificación en dos pasos</p>
          </div>

          <form onSubmit={onSubmitMfa} className="login-form">
            <div className="form-group">
              <label className="form-label">
                {metodoMfa === 'email' ? 'Código que te mandamos por email' : 'Código de tu app de autenticación'}
              </label>
              <input
                className="form-input"
                type="text"
                inputMode="numeric"
                placeholder={metodoMfa === 'email' ? '123456' : '123456 (o un código de respaldo xxxx-xxxx)'}
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                autoFocus
                required
              />
            </div>

            {metodoMfa === 'email' && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {reenviado ? 'Te mandamos otro código.' : '¿No te llegó?'}{' '}
                <button type="button" onClick={onReenviar} style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
                  Reenviar código
                </button>
              </p>
            )}

            {error && <div className="login-error">{error}</div>}

            <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '10px' }} disabled={loading}>
              {loading ? 'Verificando...' : 'Verificar'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ justifyContent: 'center', padding: '10px' }}
              onClick={() => { setChallengeId(null); setCodigo(''); setError(''); setReenviado(false); }}
            >
              Volver
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <img src="/logo.png" alt="MoraTrans" className="login-logo-mark" />
          <h1>Moratrans</h1>
          <p>Panel de gestión logística</p>
        </div>

        <form onSubmit={onSubmit} className="login-form">
          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              className="form-input"
              type="email"
              placeholder="admin@empresa.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Contraseña</label>
            <input
              className="form-input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label className="form-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              <input type="checkbox" checked={recordar} onChange={(e) => setRecordar(e.target.checked)} />
              Recordarme en este dispositivo
            </label>
            <Link to="/forgot-password" style={{ fontSize: '0.82rem' }}>¿Olvidaste tu contraseña?</Link>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ justifyContent: 'center', padding: '10px' }}
            disabled={loading}
          >
            {loading ? 'Ingresando...' : 'Ingresar al sistema'}
          </button>
        </form>

        {import.meta.env.DEV && (
          <p style={{ textAlign: 'center', marginTop: '18px', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
            Moratrans2026! para iniciar sesión en modo demo
          </p>
        )}
      </div>
    </div>
  );
}
