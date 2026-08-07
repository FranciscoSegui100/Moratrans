import { useEffect, useState } from 'react';
import { Check, Pencil, KeyRound } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

interface Usuario {
  id: string;
  nombre: string;
  email: string;
  rol: 'admin' | 'operador' | 'finanzas' | 'lectura';
  activo: boolean;
  creado_en: string;
}

const ROLES: Usuario['rol'][] = ['admin', 'operador', 'finanzas', 'lectura'];
const rolLabel: Record<Usuario['rol'], string> = {
  admin: 'Administrador',
  operador: 'Operador',
  finanzas: 'Finanzas',
  lectura: 'Lectura',
};

export function Usuarios() {
  const { user: yo } = useAuth();
  const { show } = useToast();
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [form, setForm] = useState({ nombre: '', email: '', rol: 'lectura' as Usuario['rol'] });
  const [loading, setLoading] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ nombre: string; rol: Usuario['rol'] }>({ nombre: '', rol: 'lectura' });

  const cargar = () => api.get<Usuario[]>('/api/usuarios').then((r) => setUsuarios(r.data)).catch(() => {});
  useEffect(() => { cargar(); }, []);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/api/usuarios', form);
      setForm({ nombre: '', email: '', rol: 'lectura' });
      cargar();
      if (data.emailEnviado) {
        show('success', 'Invitación enviada', `Le llegará un email a ${form.email} para elegir su contraseña`);
      } else {
        // Modo sandbox de Resend (u otro error de envío): el usuario igual
        // quedó creado, pero el link hay que pasárselo a mano.
        try { await navigator.clipboard.writeText(data.linkInvitacion); } catch { /* portapapeles no disponible, igual queda visible abajo */ }
        show('info', 'Usuario creado, pero el email no se pudo enviar', `Copiamos el link al portapapeles: ${data.linkInvitacion}`);
      }
    } catch (err: any) {
      show('error', 'Error al crear', err.response?.data?.error || 'Datos inválidos');
    } finally {
      setLoading(false);
    }
  }

  function empezarEdicion(u: Usuario) {
    setEditando(u.id);
    setEdit({ nombre: u.nombre, rol: u.rol });
  }

  async function guardarEdicion(id: string) {
    try {
      await api.patch(`/api/usuarios/${id}`, edit);
      setEditando(null);
      cargar();
      show('success', 'Usuario actualizado');
    } catch (err: any) {
      show('error', 'No se pudo actualizar', err.response?.data?.error);
    }
  }

  async function toggleActivo(u: Usuario) {
    try {
      await api.patch(`/api/usuarios/${u.id}`, { activo: !u.activo });
      cargar();
    } catch (err: any) {
      show('error', 'No se pudo cambiar el estado', err.response?.data?.error);
    }
  }

  async function resetearPassword(u: Usuario) {
    const password = prompt(`Nueva contraseña para ${u.email} (mínimo 12 caracteres, evitá algo predecible):`);
    if (!password) return;
    try {
      await api.patch(`/api/usuarios/${u.id}`, { password });
      show('success', 'Contraseña actualizada', u.email);
    } catch (err: any) {
      show('error', 'No se pudo actualizar la contraseña', err.response?.data?.error);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Usuarios</h2>
        <p>Altas y permisos de acceso al panel</p>
      </div>

      <div className="form-card">
        <div className="section-title">Crear usuario</div>
        <form onSubmit={crear} className="form-row">
          <div className="form-group">
            <label className="form-label">Nombre</label>
            <input className="form-input" placeholder="Ej. María Gómez" value={form.nombre} required
              onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input className="form-input" type="email" placeholder="maria@empresa.com" value={form.email} required
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Rol</label>
            <select className="form-select" value={form.rol}
              onChange={(e) => setForm({ ...form, rol: e.target.value as Usuario['rol'] })}>
              {ROLES.map((r) => <option key={r} value={r}>{rolLabel[r]}</option>)}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Enviando...' : 'Crear usuario'}
          </button>
        </form>
        <p className="text-muted" style={{ fontSize: '0.78rem', marginTop: '8px' }}>
          Se le manda un email de invitación para que elija su propia contraseña. No se comparte ninguna clave a mano.
        </p>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Rol</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map((u) => {
              const enEdicion = editando === u.id;
              return (
                <tr key={u.id}>
                  <td>
                    {enEdicion ? (
                      <input className="form-input" value={edit.nombre}
                        onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} />
                    ) : (
                      <div>
                        <div className="strong">{u.nombre}{u.id === yo?.id ? ' (vos)' : ''}</div>
                        <div className="text-muted">{u.email}</div>
                      </div>
                    )}
                  </td>
                  <td>
                    {enEdicion ? (
                      <select className="form-select" value={edit.rol}
                        onChange={(e) => setEdit({ ...edit, rol: e.target.value as Usuario['rol'] })}>
                        {ROLES.map((r) => <option key={r} value={r}>{rolLabel[r]}</option>)}
                      </select>
                    ) : (
                      <span className="badge programado">{rolLabel[u.rol]}</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${u.activo ? 'disponible' : 'cancelado'}`}>
                      {u.activo ? '● Activo' : '● Inactivo'}
                    </span>
                  </td>
                  <td>
                    {enEdicion ? (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => guardarEdicion(u.id)} className="btn btn-success btn-sm">
                          <Check strokeWidth={2} /> Guardar
                        </button>
                        <button onClick={() => setEditando(null)} className="btn btn-ghost btn-sm">
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => empezarEdicion(u)} className="btn btn-ghost btn-sm">
                          <Pencil strokeWidth={1.75} /> Editar
                        </button>
                        <button onClick={() => resetearPassword(u)} className="btn btn-ghost btn-sm">
                          <KeyRound strokeWidth={1.75} /> Contraseña
                        </button>
                        <button
                          onClick={() => toggleActivo(u)}
                          className="btn btn-ghost btn-sm"
                          disabled={u.id === yo?.id && u.activo}
                          title={u.id === yo?.id && u.activo ? 'No podés desactivar tu propia cuenta' : ''}
                        >
                          {u.activo ? 'Desactivar' : 'Activar'}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {usuarios.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  No hay usuarios cargados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
