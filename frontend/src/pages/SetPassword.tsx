import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';

/** Pantalla compartida por "aceptar invitación" y "restablecer contraseña": ambas son un link de un solo uso + elegir contraseña. */
export function SetPassword({ titulo }: { titulo: string }) {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const nav = useNavigate();
  const { establecerUsuario } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmar, setConfirmar] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmar) {
      setError('Las contraseñas no coinciden');
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/set-password', { token, password });
      establecerUsuario(data.user);
      nav('/');
    } catch (err: any) {
      setError(err.response?.data?.error || 'El link es inválido o venció');
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">
            <img src="/logo.png" alt="MoraTrans" className="login-logo-mark" />
            <h1>Moratrans</h1>
          </div>
          <p style={{ textAlign: 'center' }}>Este link no es válido. Pedí uno nuevo.</p>
          <p style={{ textAlign: 'center', marginTop: '18px', fontSize: '0.82rem' }}>
            <Link to="/forgot-password">Restablecer contraseña</Link>
          </p>
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
          <p>{titulo}</p>
        </div>

        <form onSubmit={onSubmit} className="login-form">
          <div className="form-group">
            <label className="form-label">Nueva contraseña</label>
            <input
              className="form-input"
              type="password"
              placeholder="Mínimo 12 caracteres, evitá algo predecible"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Confirmar contraseña</label>
            <input
              className="form-input"
              type="password"
              autoComplete="new-password"
              value={confirmar}
              onChange={(e) => setConfirmar(e.target.value)}
              required
              minLength={12}
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '10px' }} disabled={loading}>
            {loading ? 'Guardando...' : 'Guardar y entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
