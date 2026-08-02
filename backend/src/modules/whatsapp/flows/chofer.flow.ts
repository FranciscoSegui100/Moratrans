import { query } from '../../../config/db';
import { sendText, sendList } from '../graphApi';
import { setSesion, clearSesion } from '../session.store';
import { emitAlerta } from '../../../config/socket';
import { blindIndex } from '../../../services/crypto.service';
import type { MensajeEntrante } from '../messageRouter';
import type { Sesion } from '../session.store';

// Únicos estados que un chofer puede aplicar.
const ESTADOS_CHOFER = ['en_camino', 'entregado', 'retirado'] as const;

export async function handleChofer(m: MensajeEntrante, sesion: Sesion): Promise<void> {
  const to = m.from;

  // 1) Identificación por teléfono
  const chofer = await query<{ id: string; nombre: string }>(
    'SELECT id, nombre FROM choferes WHERE telefono = $1 AND activo = TRUE',
    [to],
  );

  // 1a) No reconocido: pedir DNI para validar
  if (chofer.length === 0) {
    if (sesion.paso === 'esperando_dni' && m.tipo === 'text') {
      const dni = (m.texto ?? '').replace(/\D/g, '');
      const match = await query<{ id: string; nombre: string }>(
        'SELECT id, nombre FROM choferes WHERE dni_hash = $1 AND activo = TRUE',
        [blindIndex(dni)],
      );
      if (match.length > 0) {
        // Vincular teléfono al chofer existente
        await query('UPDATE choferes SET telefono = $1 WHERE id = $2', [to, match[0].id]);
        await clearSesion(to);
        await sendText(to, `✅ ¡Listo, ${match[0].nombre}! Tu número quedó vinculado.`);
        return menuChofer(to);
      }
      // No coincide: derivar a operador
      const [alerta] = await query(
        `INSERT INTO alertas (tipo, referencia_id, mensaje)
         VALUES ('chofer_no_reconocido', $1, $2) RETURNING id, tipo, referencia_id, mensaje, creado_en`,
        [to, `Chofer no reconocido (${to}) intentó validarse con DNI ${dni}`],
      );
      if (alerta) emitAlerta(alerta);
      await clearSesion(to);
      await sendText(to, 'No pudimos validar tu DNI. Derivamos tu caso a un operador que se comunicará contigo.');
      return;
    }
    // Primer contacto: pedir DNI
    await setSesion({ telefono: to, flujo: 'chofer', paso: 'esperando_dni', contexto: {} });
    await sendText(to, '🚚 Hola. No reconozco este número. Enviá tu *DNI* para validarte como chofer.');
    return;
  }

  // 2) Chofer reconocido: manejar cambio de estado
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('estado:')) {
    return elegirContenedor(to, chofer[0].id, m.seleccionId.replace('estado:', ''), sesion);
  }
  if (m.tipo === 'interactive_list' && m.seleccionId?.startsWith('cont:')) {
    return aplicarEstado(to, chofer[0].id, m.seleccionId.replace('cont:', ''), sesion);
  }

  return menuChofer(to);
}

/** Menú principal del chofer: elegir estado logístico. */
async function menuChofer(to: string): Promise<void> {
  await sendList(
    to,
    'Panel del chofer',
    'Elegí la acción a registrar:',
    'Ver acciones',
    ESTADOS_CHOFER.map((e) => ({ id: `estado:${e}`, title: e.replace('_', ' ') })),
  );
}

/** Tras elegir estado, listar contenedores candidatos. */
async function elegirContenedor(to: string, choferId: string, estado: string, sesion: Sesion): Promise<void> {
  if (!ESTADOS_CHOFER.includes(estado as any)) {
    await sendText(to, 'Acción no permitida para choferes.');
    return;
  }
  // Contenedores en un estado desde el que la transición es válida.
  const origen =
    estado === 'en_camino' ? 'reservado' : estado === 'entregado' ? 'en_camino' : 'entregado';
  const conts = await query<{ numero: string }>(
    'SELECT numero FROM contenedores WHERE estado = $1 ORDER BY actualizado_en LIMIT 10',
    [origen],
  );
  if (conts.length === 0) {
    await sendText(to, `No hay contenedores en estado "${origen}" para pasar a "${estado.replace('_', ' ')}".`);
    return menuChofer(to);
  }
  await setSesion({ telefono: to, flujo: 'chofer', paso: 'elegir_contenedor', contexto: { estado } });
  await sendList(
    to,
    `Marcar como ${estado.replace('_', ' ')}`,
    'Elegí el contenedor:',
    'Ver contenedores',
    conts.map((c) => ({ id: `cont:${c.numero}`, title: c.numero })),
  );
}

/** Aplica el cambio de estado (el trigger de la DB valida la transición y audita). */
async function aplicarEstado(
  to: string,
  choferId: string,
  numero: string,
  sesion: Sesion,
): Promise<void> {
  const estado = sesion.contexto.estado as string;
  if (!ESTADOS_CHOFER.includes(estado as any)) {
    await sendText(to, 'Acción no permitida.');
    await clearSesion(to);
    return;
  }
  try {
    // El trigger fn_validar_transicion_contenedor rechaza transiciones ilegales.
    await query(
      'UPDATE contenedores SET estado = $1, actualizado_por = $2 WHERE numero = $3',
      [estado, `chofer:${choferId}`, numero],
    );
    // Historial explícito con el chofer (el trigger también audita, pero sin chofer_id).
    await query(
      'INSERT INTO historial_contenedores (numero_contenedor, estado, chofer_id, nota) VALUES ($1,$2,$3,$4)',
      [numero, estado, choferId, 'registrado por chofer vía WhatsApp'],
    );
    await clearSesion(to);
    await sendText(to, `✅ Contenedor *${numero}* marcado como *${estado.replace('_', ' ')}*.`);
  } catch (err: any) {
    // Error de transición inválida u otro
    await sendText(
      to,
      `⚠️ No se pudo aplicar el cambio en ${numero}. ` +
        'Puede que el contenedor no esté en el estado correcto. Escribí *menú*.',
    );
    console.error('Error aplicarEstado:', err.message);
  }
}
