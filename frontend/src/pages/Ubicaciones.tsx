import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Ubicacion {
  id: string;
  tipo: 'deposito' | 'vaciadero';
  nombre: string;
  direccion: string;
  activo: boolean;
}

const ETIQUETA_TIPO: Record<Ubicacion['tipo'], string> = {
  deposito: 'Depósito',
  vaciadero: 'Vaciadero',
};

export function Ubicaciones() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ tipo: Ubicacion['tipo']; nombre: string; direccion: string }>({
    tipo: 'deposito',
    nombre: '',
    direccion: '',
  });
  const [loading, setLoading] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [edit, setEdit] = useState({ nombre: '', direccion: '' });

  const { data: ubicaciones = [] } = useQuery({
    queryKey: ['ubicaciones'],
    queryFn: () => api.get<Ubicacion[]>('/api/ubicaciones').then((r) => r.data),
  });
  const cargar = () => queryClient.invalidateQueries({ queryKey: ['ubicaciones'] });

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/ubicaciones', form);
      setForm({ tipo: form.tipo, nombre: '', direccion: '' });
      cargar();
      show('success', 'Ubicación agregada', form.nombre);
    } catch (err: any) {
      show('error', 'Error al agregar', err.response?.data?.error || 'Datos inválidos');
    } finally {
      setLoading(false);
    }
  }

  function empezarEdicion(u: Ubicacion) {
    setEditando(u.id);
    setEdit({ nombre: u.nombre, direccion: u.direccion });
  }

  async function guardarEdicion(id: string) {
    try {
      await api.patch(`/api/ubicaciones/${id}`, edit);
      setEditando(null);
      cargar();
      show('success', 'Ubicación actualizada');
    } catch {
      show('error', 'No se pudo actualizar la ubicación');
    }
  }

  async function toggleActivo(u: Ubicacion) {
    try {
      await api.patch(`/api/ubicaciones/${u.id}`, { activo: !u.activo });
      cargar();
    } catch {
      show('error', 'No se pudo cambiar el estado');
    }
  }

  async function borrar(u: Ubicacion) {
    if (!confirm(`¿Eliminar "${u.nombre}"? Esta acción no se puede deshacer.`)) return;
    try {
      await api.delete(`/api/ubicaciones/${u.id}`);
      cargar();
      show('info', 'Ubicación eliminada', u.nombre);
    } catch (err: any) {
      show('error', 'No se pudo eliminar', err.response?.data?.error);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Ubicaciones</h2>
        <p>Depósitos (origen de una entrega) y vaciaderos (destino de un retiro)</p>
      </div>

      <RoleGate roles={['admin']}>
        <div className="form-card">
          <div className="section-title">Agregar ubicación</div>
          <form onSubmit={crear} className="form-row">
            <div className="form-group">
              <label className="form-label">Tipo</label>
              <select
                className="form-select"
                value={form.tipo}
                onChange={(e) => setForm({ ...form, tipo: e.target.value as Ubicacion['tipo'] })}
              >
                <option value="deposito">Depósito</option>
                <option value="vaciadero">Vaciadero</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Nombre</label>
              <input
                className="form-input"
                placeholder="Ej. Depósito central"
                value={form.nombre}
                required
                onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Dirección</label>
              <input
                className="form-input"
                placeholder="Ej. Ruta 7 km 12, Godoy Cruz"
                value={form.direccion}
                required
                onChange={(e) => setForm({ ...form, direccion: e.target.value })}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Agregar ubicación'}
            </button>
          </form>
        </div>
      </RoleGate>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Nombre</th>
              <th>Dirección</th>
              <th>Estado</th>
              <RoleGate roles={['admin']}><th>Acciones</th></RoleGate>
            </tr>
          </thead>
          <tbody>
            {ubicaciones.map((u) => {
              const enEdicion = editando === u.id;
              return (
                <tr key={u.id}>
                  <td>
                    <span className={`badge ${u.tipo === 'deposito' ? 'reservado' : 'retirado'}`}>
                      {ETIQUETA_TIPO[u.tipo]}
                    </span>
                  </td>
                  <td className="strong">
                    {enEdicion ? (
                      <input
                        className="form-input"
                        value={edit.nombre}
                        onChange={(e) => setEdit({ ...edit, nombre: e.target.value })}
                      />
                    ) : (
                      u.nombre
                    )}
                  </td>
                  <td>
                    {enEdicion ? (
                      <input
                        className="form-input"
                        value={edit.direccion}
                        onChange={(e) => setEdit({ ...edit, direccion: e.target.value })}
                      />
                    ) : (
                      u.direccion
                    )}
                  </td>
                  <td>
                    <span className={`badge ${u.activo ? 'disponible' : 'cancelado'}`}>
                      {u.activo ? '● Activo' : '● Inactivo'}
                    </span>
                  </td>
                  <RoleGate roles={['admin']}>
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
                          <button onClick={() => toggleActivo(u)} className="btn btn-ghost btn-sm">
                            {u.activo ? 'Desactivar' : 'Activar'}
                          </button>
                          {!u.activo && (
                            <button onClick={() => borrar(u)} className="btn btn-danger btn-sm">
                              <Trash2 strokeWidth={1.75} /> Eliminar
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </RoleGate>
                </tr>
              );
            })}
            {ubicaciones.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  No hay ubicaciones cargadas
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
