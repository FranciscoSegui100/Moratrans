-- 0056 corrigió el mismo problema apuntando a 'Ciudad' (el nombre que tenía
-- la fila en el momento de escribir esa migración), pero para cuando el
-- deploy la corrió la fila ya se llamaba 'Capital' de nuevo — no hay ningún
-- endpoint del panel que pueda renombrar este departamento (ver
-- tarifas.routes.ts: PATCH solo toca precio/activo, POST sólo inserta uno
-- nuevo), así que el cambio de nombre fue una edición directa en la base,
-- por fuera de la app. Mientras no sepamos por qué el nombre va y viene,
-- esta versión cubre ambos para que el polígono quede cargado pase lo que
-- pase con el nombre.
UPDATE tarifas_departamento SET limite_geografico = '[[-69.09022,-32.86347],[-69.08703,-32.86678],[-69.0815,-32.86822],[-69.08255,-32.86941],[-69.07973,-32.87235],[-69.08186,-32.87562],[-69.08113,-32.87852],[-69.07834,-32.88262],[-69.07977,-32.8873],[-69.07905,-32.8894],[-69.07875,-32.8953],[-69.08115,-32.897],[-69.08171,-32.90068],[-69.08418,-32.90369],[-69.08408,-32.90463],[-68.89556,-32.90459],[-68.89485,-32.90085],[-68.88734,-32.89931],[-68.86757,-32.90107],[-68.86367,-32.90248],[-68.85187,-32.90244],[-68.85191,-32.90306],[-68.83763,-32.90454],[-68.83683,-32.90166],[-68.83083,-32.8928],[-68.82638,-32.87685],[-68.82036,-32.8739],[-68.82006,-32.87213],[-68.81807,-32.86962],[-68.81726,-32.86736],[-68.82266,-32.86647],[-68.8331,-32.86665],[-68.83245,-32.86428],[-68.83269,-32.86204],[-68.88298,-32.86426],[-68.88323,-32.86522],[-68.88652,-32.86586],[-68.8902,-32.8652],[-68.8907,-32.86337],[-69.09022,-32.86347]]'::jsonb
 WHERE departamento IN ('Ciudad', 'Capital');
