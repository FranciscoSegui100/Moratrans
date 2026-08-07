import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';

export function ForgotPassword() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') || '');
  const [enviado, setEnviado] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/auth/forgot-password', { email });
    } finally {
      // Siempre mostramos el mismo mensaje, exista o no la cuenta: no hay
      // que dejar adivinar qué emails están dados de alta en el panel.
      setEnviado(true);
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <div className="login-logo-mark">MT</div>
          <h1>Moratrans</h1>
          <p>Restablecer contraseña</p>
        </div>

        {enviado ? (
          <p style={{ textAlign: 'center', fontSize: '0.9rem' }}>
            Si <strong>{email}</strong> tiene una cuenta activa, le llegó un email con instrucciones. Revisá también spam.
          </p>
        ) : (
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
            <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '10px' }} disabled={loading}>
              {loading ? 'Enviando...' : 'Enviar instrucciones'}
            </button>
          </form>
        )}

        <p style={{ textAlign: 'center', marginTop: '18px', fontSize: '0.82rem' }}>
          <Link to="/login">Volver a iniciar sesión</Link>
        </p>
      </div>
    </div>
  );
}
