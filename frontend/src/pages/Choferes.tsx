import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Trash2, Unlink } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Chofer { id: string; nombre: string; dni: string | null; telefono: string | null; patente: string | null; activo: boolean; }

function initials(name: string) {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

export function Choferes() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ nombre: '', dni: '', telefono: '', patente: '' });
  const [loading, setLoading] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [edit, setEdit] = useState({ nombre: '', dni: '', telefono: '', patente: '' });

  const { data: choferes = [] } = useQuery({
    queryKey: ['choferes'],
    queryFn: () => api.get<Chofer[]>('/api/choferes').then((r) => r.data),
  });
  // Invalida las dos variantes cacheadas de este endpoint: la lista completa
  // (esta página) y la filtrada por activos que usa Pagos.tsx.
  const cargar = () => queryClient.invalidateQueries({ queryKey: ['choferes'] });

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/choferes', { ...form, patente: form.patente || undefined });
      setForm({ nombre: '', dni: '', telefono: '', patente: '' });
      cargar();
      show('success', 'Chofer creado', form.nombre);
    } catch (err: any) {
      show('error', 'Error al crear', err.response?.data?.error || 'DNI o teléfono duplicado');
    } finally {
      setLoading(false);
    }
  }

  function empezarEdicion(c: Chofer) {
    setEditando(c.id);
    setEdit({ nombre: c.nombre, dni: c.dni && c.dni !== '••••••' ? c.dni : '', telefono: c.telefono ?? '', patente: c.patente ?? '' });
  }

  async function guardarEdicion(id: string) {
    try {
      // Si el DNI está enmascarado (rol sin permiso) o no se tocó, no lo mandamos.
      const { nombre, telefono, dni, patente } = edit;
      const payload: Record<string, string | null> = { nombre, telefono, patente: patente || null };
      if (dni) payload.dni = dni;
      await api.patch(`/api/choferes/${id}`, payload);
      setEditando(null);
      cargar();
      show('success', 'Chofer actualizado', nombre);
    } catch (err: any) {
      show('error', 'No se pudo actualizar', err.response?.data?.error || 'DNI o teléfono duplicado');
    }
  }

  async function toggleActivo(c: Chofer) {
    try {
      await api.patch(`/api/choferes/${c.id}`, { activo: !c.activo });
      cargar();
    } catch {
      show('error', 'No se pudo cambiar el estado');
    }
  }

  async function desvincular(id: string, nombre: string) {
    if (!confirm(`¿Desvincular el número de WhatsApp de ${nombre}? Podrá vincularse a otro chofer recién después de esto.`)) return;
    try {
      await api.post(`/api/choferes/${id}/desvincular`);
      cargar();
      show('info', 'Número desvinculado', nombre);
    } catch {
      show('error', 'No se pudo desvincular el número');
    }
  }

  async function borrar(id: string, nombre: string) {
    if (!confirm(`¿Eliminar al chofer ${nombre}?`)) return;
    try {
      await api.delete(`/api/choferes/${id}`);
      cargar();
      show('info', 'Chofer eliminado');
    } catch (err: any) {
      show('error', 'No se puede eliminar', err.response?.data?.error);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Choferes</h2>
        <p>Alta, edición y gestión de choferes del sistema</p>
      </div>

      <RoleGate roles={['admin', 'operador']}>
        <div className="form-card">
          <div className="section-title">Agregar nuevo chofer</div>
          <form onSubmit={crear} className="form-row">
            <div className="form-group">
              <label className="form-label">Nombre completo</label>
              <input className="form-input" placeholder="Ej. Juan Pérez" value={form.nombre} required
                onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">DNI</label>
              <input className="form-input" placeholder="12345678" value={form.dni} required
                onChange={(e) => setForm({ ...form, dni: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Teléfono</label>
              <input className="form-input" placeholder="Ej. 0261 15-206-2258 (cualquier formato sirve)" value={form.telefono} required
                onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Patente (opcional)</label>
              <input className="form-input" placeholder="Ej. AF469SO" value={form.patente}
                onChange={(e) => setForm({ ...form, patente: e.target.value.toUpperCase() })} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Agregar chofer'}
            </button>
          </form>
        </div>
      </RoleGate>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Chofer</th>
              <th>DNI</th>
              <th>Teléfono</th>
              <th>Patente</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {choferes.map((c) => {
              const enEdicion = editando === c.id;
              return (
                <tr key={c.id}>
                  <td>
                    {enEdicion ? (
                      <input
                        className="form-input"
                        value={edit.nombre}
                        onChange={(e) => setEdit({ ...edit, nombre: e.target.value })}
                      />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div className="avatar">
                          {initials(c.nombre)}
                        </div>
                        <span className="strong">{c.nombre}</span>
                      </div>
                    )}
                  </td>
                  <td className="mono">
                    {enEdicion ? (
                      <input
                        className="form-input"
                        placeholder={c.dni === '••••••' ? '(sin cambios)' : c.dni ?? '(anonimizado — cargar uno nuevo si corresponde)'}
                        value={edit.dni}
                        onChange={(e) => setEdit({ ...edit, dni: e.target.value })}
                      />
                    ) : c.dni ? (
                      c.dni
                    ) : (
                      <span className="text-muted" title="Se anonimizó automáticamente por retención de datos (chofer inactivo hace más de un año)">
                        Anonimizado
                      </span>
                    )}
                  </td>
                  <td>
                    {enEdicion ? (
                      <input
                        className="form-input"
                        value={edit.telefono}
                        onChange={(e) => setEdit({ ...edit, telefono: e.target.value })}
                      />
                    ) : c.telefono ? (
                      c.telefono
                    ) : (
                      <span className="text-muted">Sin vincular</span>
                    )}
                  </td>
                  <td className="mono">
                    {enEdicion ? (
                      <input
                        className="form-input"
                        value={edit.patente}
                        onChange={(e) => setEdit({ ...edit, patente: e.target.value.toUpperCase() })}
                      />
                    ) : c.patente ? (
                      c.patente
                    ) : (
                      <span className="text-muted">Sin patente</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${c.activo ? 'disponible' : 'cancelado'}`}>
                      {c.activo ? '● Activo' : '● Inactivo'}
                    </span>
                  </td>
                  <td>
                    <RoleGate roles={['admin', 'operador']}>
                      {enEdicion ? (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button onClick={() => guardarEdicion(c.id)} className="btn btn-success btn-sm">
                            <Check strokeWidth={2} /> Guardar
                          </button>
                          <button onClick={() => setEditando(null)} className="btn btn-ghost btn-sm">
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button onClick={() => empezarEdicion(c)} className="btn btn-ghost btn-sm">
                            <Pencil strokeWidth={1.75} /> Editar
                          </button>
                          {c.telefono && (
                            <button
                              onClick={() => desvincular(c.id, c.nombre)}
                              className="btn btn-ghost btn-sm"
                              title="Libera el número para poder vincularlo a otro chofer"
                            >
                              <Unlink strokeWidth={1.75} /> Desvincular
                            </button>
                          )}
                          <button onClick={() => toggleActivo(c)} className="btn btn-ghost btn-sm">
                            {c.activo ? 'Desactivar' : 'Activar'}
                          </button>
                          <button onClick={() => borrar(c.id, c.nombre)} className="btn btn-danger btn-sm">
                            <Trash2 strokeWidth={1.75} /> Eliminar
                          </button>
                        </div>
                      )}
                    </RoleGate>
                  </td>
                </tr>
              );
            })}
            {choferes.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  No hay choferes registrados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
