/**
 * Siluetas de carga. Se muestran SOLO cuando todavía no hay ningún dato
 * (`isLoading` de React Query, nunca `isFetching`): con staleTime de 30s y
 * refetch al volver a la pestaña, usar isFetching haría parpadear la pantalla
 * cada vez que se revalida en segundo plano teniendo datos buenos a la vista.
 *
 * Cada variante imita la forma real de lo que va a aparecer. Si la silueta no
 * coincide con el contenido, el salto al llegar los datos se nota más que
 * dejar la pantalla vacía — por eso son variantes por forma y no un
 * rectángulo genérico.
 */

/** Una barra. `w` admite cualquier unidad CSS; `h` va en px. `pill` la
 *  redondea del todo, para imitar un botón. */
export function SkeletonBarra({ w = '100%', h = 12, pill = false }: { w?: string; h?: number; pill?: boolean }) {
  return <span className={`skeleton${pill ? ' skeleton-pill' : ''}`} style={{ width: w, height: h }} />;
}

/** Silueta de .pago-card: avatar redondo, dos líneas de texto y dos botones. */
export function SkeletonPagos({ filas = 3 }: { filas?: number }) {
  return (
    <div className="space-y" aria-hidden="true">
      {Array.from({ length: filas }, (_, i) => (
        <div key={i} className="pago-card skeleton-card">
          <div className="pago-card-top">
            <span className="skeleton skeleton-avatar" />
            <div className="pago-info">
              <SkeletonBarra w="130px" h={13} />
              <div style={{ marginTop: 6 }}>
                <SkeletonBarra w="270px" h={11} />
              </div>
            </div>
            <div className="pago-actions">
              <SkeletonBarra w="62px" h={26} pill />
              <SkeletonBarra w="78px" h={26} pill />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
