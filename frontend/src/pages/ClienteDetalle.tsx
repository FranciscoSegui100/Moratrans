import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, Send } from 'lucide-react';
import { api, descargarArchivo } from '../api/client';
import { RoleGate } from '../components/RoleGate';
import { useToast } from '../components/Toast';

interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  cuenta_corriente_estado: 'sin_pedir' | 'pendiente' | 'aprobada' | 'rechazada';
  numero_plan: number | null;
}

interface ViajeCliente {
  id: string;
  tipo: 'entrega' | 'retiro';
  fecha: string;
  estado: string;
  zona: string | null;
  destino_direccion: string | null;
  patente: string | null;
  remito: string | null;
  importe: string | null;
  grupo_id: string | null;
  chofer_nombre: string | null;
}

const ETIQUETA_CC: Record<Cliente['cuenta_corriente_estado'], { texto: string; clase: string }> = {
  sin_pedir: { texto: 'Sin pedir', clase: 'retirado' },
  pendiente: { texto: 'Pendiente', clase: 'pendiente' },
  aprobada: { texto: 'Aprobada', clase: 'disponible' },
  rechazada: { texto: 'Rechazada', clase: 'rechazado' },
};

/** Mismo criterio que excelClientes() en el backend — mantener en sync. */
function tipoBulto(v: ViajeCliente): string {
  if (v.tipo === 'entrega') return 'VACIO';
  if (v.grupo_id) return 'Recambio';
  return 'Retiro';
}

function etiquetaMes(mes: string): string {
  const [anio, m] = mes.split('-');
  const texto = new Date(Number(anio), Number(m) - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// TEMPORAL: viajes de ejemplo para previsualizar cómo queda la tabla con
// datos de un cliente de cuenta corriente activo. Sacar cuando ya no haga falta.
function viajesDeEjemplo(): ViajeCliente[] {
  const hoy = new Date();
  const ejemplos: ViajeCliente[] = [];
  for (let mesesAtras = 0; mesesAtras < 4; mesesAtras++) {
    const base = new Date(hoy.getFullYear(), hoy.getMonth() - mesesAtras, 1);
    for (let i = 0; i < 3; i++) {
      const dia = 5 + i * 8;
      const fecha = new Date(base.getFullYear(), base.getMonth(), dia);
      const idx = mesesAtras * 3 + i;
      ejemplos.push({
        id: `demo-${idx}`,
        tipo: idx % 2 === 0 ? 'retiro' : 'entrega',
        fecha: fecha.toISOString().slice(0, 10),
        estado: 'entregado',
        zona: 'Zona Norte',
        destino_direccion: 'Av. Ejemplo 1234',
        patente: 'AB123CD',
        remito: `R-${1000 + idx}`,
        importe: '15000',
        grupo_id: idx % 3 === 0 ? `grupo-${idx}` : null,
        chofer_nombre: 'Juan Pérez',
      });
    }
  }
  return ejemplos;
}

export function ClienteDetalle() {
  const { telefono = '' } = useParams<{ telefono: string }>();
  const { show } = useToast();
  const [enviando, setEnviando] = useState(false);

  async function enviarPorWhatsApp() {
    setEnviando(true);
    try {
      await api.post(`/api/clientes/${encodeURIComponent(telefono)}/enviar-excel`);
      show('success', 'Enviado por WhatsApp', telefono);
    } catch (err: any) {
      show('error', 'No se pudo enviar', err.response?.data?.error);
    } finally {
      setEnviando(false);
    }
  }

  const { data: clientes = [] } = useQuery({
    queryKey: ['clientes'],
    queryFn: () => api.get<Cliente[]>('/api/clientes').then((r) => r.data),
  });
  const cliente = clientes.find((c) => c.telefono === telefono);

  const { data: viajesReales = [] } = useQuery({
    queryKey: ['clientes', telefono, 'viajes'],
    queryFn: () => api.get<ViajeCliente[]>(`/api/clientes/${encodeURIComponent(telefono)}/viajes`).then((r) => r.data),
    enabled: !!telefono,
  });
  // TEMPORAL: si es cuenta corriente y todavía no tiene viajes reales, se
  // muestran de ejemplo para previsualizar cómo queda la tabla con datos.
  const esCC = cliente?.cuenta_corriente_estado === 'aprobada' || cliente?.cuenta_corriente_estado === 'pendiente';
  const viajes = viajesReales.length === 0 && esCC ? viajesDeEjemplo() : viajesReales;

  // Ya vienen ordenados por fecha DESC desde el backend: agrupar preservando
  // ese orden deja los meses más recientes arriba sin tener que reordenar.
  const grupos = useMemo(() => {
    const porMes = new Map<string, ViajeCliente[]>();
    for (const v of viajes) {
      const mes = v.fecha.slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, []);
      porMes.get(mes)!.push(v);
    }
    return [...porMes.entries()];
  }, [viajes]);

  const cc = cliente ? ETIQUETA_CC[cliente.cuenta_corriente_estado] : null;

  return (
    <div>
      <div className="page-header">
        <Link to="/clientes" className="btn btn-ghost btn-sm" style={{ marginBottom: '10px' }}>
          <ArrowLeft size={14} strokeWidth={1.75} /> Volver a Clientes
        </Link>
        <h2>{cliente?.nombre ?? telefono}</h2>
        <p>
          {telefono}
          {cliente?.numero_plan != null && <> · Nº plan {cliente.numero_plan}</>}
          {cc && <> · <span className={`badge ${cc.clase}`}>{cc.texto}</span></>}
        </p>
      </div>

      <div className="form-card" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          className="btn btn-primary"
          onClick={() => descargarArchivo(`/api/clientes/export.xlsx?telefono=${encodeURIComponent(telefono)}`, `${cliente?.nombre ?? telefono}.xlsx`)}
        >
          <Download strokeWidth={1.75} /> Exportar a Excel
        </button>
        <RoleGate roles={['admin', 'operador', 'finanzas']}>
          <button className="btn btn-ghost" onClick={enviarPorWhatsApp} disabled={enviando}>
            <Send strokeWidth={1.75} /> {enviando ? 'Enviando...' : 'Enviar por WhatsApp'}
          </button>
        </RoleGate>
      </div>

      {grupos.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-title">Sin viajes registrados</div>
          </div>
        </div>
      ) : (
        grupos.map(([mes, viajesDelMes]) => (
          <div key={mes} style={{ marginTop: '20px' }}>
            <div className="section-title">{etiquetaMes(mes)}</div>
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>FECHA</th><th>CHA/EQU</th><th>PAT</th><th>POSICIÓN</th>
                    <th>TIPO BULTO</th><th>CANTIDAD</th><th>Nº REMITO</th>
                    <th>IMPORTE</th><th>CHOFER</th><th>ESTADO</th>
                  </tr>
                </thead>
                <tbody>
                  {viajesDelMes.map((v) => (
                    <tr key={v.id}>
                      <td>{v.fecha}</td>
                      <td>Contenedor</td>
                      <td className="mono">{v.patente ?? '—'}</td>
                      <td>{v.destino_direccion ?? v.zona ?? '—'}</td>
                      <td>{tipoBulto(v)}</td>
                      <td>1</td>
                      <td className="mono">{v.remito ?? '—'}</td>
                      <td>{v.importe ? `$${Number(v.importe).toLocaleString('es-AR')}` : <span className="text-muted">—</span>}</td>
                      <td>{v.chofer_nombre ?? '—'}</td>
                      <td><span className={`badge ${v.estado}`}>{v.estado}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
