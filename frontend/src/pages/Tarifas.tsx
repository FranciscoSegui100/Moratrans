import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Tarifa {
  departamento: string;
  precio: string;
  moneda: string;
  activo: boolean;
  actualizado_en: string;
}

export function Tarifas() {
  const { show } = useToast();
  const [tarifas, setTarifas] = useState<Tarifa[]>([]);
  const [form, setForm] = useState({ departamento: '', precio: '', moneda: 'ARS' });
  const [loading, setLoading] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [edit, setEdit] = useState({ precio: '', moneda: '' });

  const cargar = () => api.get<Tarifa[]>('/api/tarifas').then((r) => setTarifas(r.data)).catch(() => {});
  useEffect(() => { cargar(); }, []);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/tarifas', form);
      setForm({ departamento: '', precio: '', moneda: form.moneda });
      cargar();
      show('success', 'Departamento agregado', form.departamento);
    } catch (err: any) {
      show('error', 'Error al agregar', err.response?.data?.error || 'Departamento duplicado');
    } finally {
      setLoading(false);
    }
  }

  function empezarEdicion(t: Tarifa) {
    setEditando(t.departamento);
    setEdit({ precio: t.precio, moneda: t.moneda });
  }

  async function guardarEdicion(departamento: string) {
    try {
      await api.patch(`/api/tarifas/${encodeURIComponent(departamento)}`, {
        precio: Number(edit.precio),
        moneda: edit.moneda,
      });
      setEditando(null);
      cargar();
      show('success', 'Tarifa actualizada', departamento);
    } catch {
      show('error', 'No se pudo actualizar la tarifa');
    }
  }

  async function toggleActivo(t: Tarifa) {
    try {
      await api.patch(`/api/tarifas/${encodeURIComponent(t.departamento)}`, { activo: !t.activo });
      cargar();
    } catch {
      show('error', 'No se pudo cambiar el estado');
    }
  }

  async function borrar(departamento: string) {
    if (!confirm(`¿Eliminar el departamento ${departamento}? Esta acción no se puede deshacer.`)) return;
    try {
      await api.delete(`/api/tarifas/${encodeURIComponent(departamento)}`);
      cargar();
      show('info', 'Departamento eliminado', departamento);
    } catch (err: any) {
      show('error', 'No se pudo eliminar', err.response?.data?.error);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Tarifas</h2>
        <p>Precio y moneda por departamento — el bot siempre cotiza con estos valores</p>
      </div>

      <RoleGate roles={['admin']}>
        <div className="form-card">
          <div className="section-title">Agregar departamento</div>
          <form onSubmit={crear} className="form-row">
            <div className="form-group">
              <label className="form-label">Departamento</label>
              <input className="form-input" placeholder="Ej. Lavalle" value={form.departamento} required
                onChange={(e) => setForm({ ...form, departamento: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Precio</label>
              <input className="form-input" type="number" min="0" step="0.01" placeholder="8000" value={form.precio} required
                onChange={(e) => setForm({ ...form, precio: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Moneda</label>
              <input className="form-input" placeholder="ARS" value={form.moneda} required maxLength={10}
                onChange={(e) => setForm({ ...form, moneda: e.target.value.toUpperCase() })} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : '+ Agregar'}
            </button>
          </form>
        </div>
      </RoleGate>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Departamento</th>
              <th>Precio</th>
              <th>Moneda</th>
              <th>Estado</th>
              <RoleGate roles={['admin']}><th>Acciones</th></RoleGate>
            </tr>
          </thead>
          <tbody>
            {tarifas.map((t) => {
              const enEdicion = editando === t.departamento;
              return (
                <tr key={t.departamento}>
                  <td className="strong">{t.departamento}</td>
                  <td>
                    {enEdicion ? (
                      <input
                        className="form-input"
                        type="number"
                        min="0"
                        step="0.01"
                        style={{ maxWidth: '120px' }}
                        value={edit.precio}
                        onChange={(e) => setEdit({ ...edit, precio: e.target.value })}
                      />
                    ) : (
                      Number(t.precio).toLocaleString('es-AR')
                    )}
                  </td>
                  <td>
                    {enEdicion ? (
                      <input
                        className="form-input"
                        style={{ maxWidth: '80px' }}
                        maxLength={10}
                        value={edit.moneda}
                        onChange={(e) => setEdit({ ...edit, moneda: e.target.value.toUpperCase() })}
                      />
                    ) : (
                      t.moneda
                    )}
                  </td>
                  <td>
                    <span className={`badge ${t.activo ? 'disponible' : 'cancelado'}`}>
                      {t.activo ? '● Activo' : '● Inactivo'}
                    </span>
                  </td>
                  <RoleGate roles={['admin']}>
                    <td>
                      {enEdicion ? (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button onClick={() => guardarEdicion(t.departamento)} className="btn btn-success btn-sm">
                            ✓ Guardar
                          </button>
                          <button onClick={() => setEditando(null)} className="btn btn-ghost btn-sm">
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button onClick={() => empezarEdicion(t)} className="btn btn-ghost btn-sm">
                            ✏️ Editar
                          </button>
                          <button onClick={() => toggleActivo(t)} className="btn btn-ghost btn-sm">
                            {t.activo ? 'Desactivar' : 'Activar'}
                          </button>
                          {!t.activo && (
                            <button onClick={() => borrar(t.departamento)} className="btn btn-danger btn-sm">
                              🗑️ Eliminar
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </RoleGate>
                </tr>
              );
            })}
            {tarifas.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  No hay departamentos cargados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
