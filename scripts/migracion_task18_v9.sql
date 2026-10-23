-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY · Migración Task 18 (v9) — Ubicaciones en 0 visibles en Stock (verde)
-- ═══════════════════════════════════════════════════════════════════════════
-- QUÉ CAMBIA:
--   stock_por_codigo_kardex: HAVING stock > 0  →  HAVING stock >= 0
--
-- POR QUÉ:
--   Antes, una ubicación que quedaba en 0 exacto (ingresos = salidas, p.ej.
--   tras corrección de un stock negativo) DESAPARECÍA de la pestaña Stock.
--   Ahora el RPC devuelve también las ubicaciones en 0 exacto (con historial
--   de movimientos) y la UI las pinta en VERDE como "vacía".
--
-- SEGURIDAD (Task 18 · paso 5):
--   · RqUbicacionesDialog ya filtra stock > 0 client-side  → sin cambio visual.
--   · RqAtenderQrWizard usa el saldo como PRE-chequeo: una celda en 0 bloquea
--     tomas desde ella (mejora); la validación real sigue en la RPC de salida.
--   · Las filas NEGATIVAS siguen ocultas (>= 0 las excluye).
--   · STABLE, SECURITY INVOKER (igual que antes); solo lectura.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.stock_por_codigo_kardex(p_codigo text, p_solo_inc boolean DEFAULT false)
 RETURNS TABLE(bloque text, torre text, piso text, posicion text, stock numeric, descripcion text, un text, proveedor text, f_vencimiento date)
 LANGUAGE sql
 STABLE
AS $function$
WITH src AS (
  SELECT m.bloque, m.torre, m.piso, m.posicion, m.tipo, m.cantidad,
         m.descripcion, m.un, m.proveedor, m.f_modificacion, m.id,
         COALESCE(m.f_vencimiento::text, '') AS venc
  FROM public.movimientos m
  WHERE m.codigo = p_codigo
    AND (CASE WHEN p_solo_inc
              THEN (m.codigo_inc IS NOT NULL AND m.codigo_inc <> '')
              ELSE (m.codigo_inc IS NULL) END)
),
grupos AS (
  SELECT s.bloque, s.torre, s.piso, s.posicion,
         ROUND(SUM(CASE WHEN s.tipo IN ('ingreso','devolucion','traslado','stock_inicial')
                        THEN s.cantidad ELSE -s.cantidad END), 3) AS stock,
         MAX(s.descripcion) AS descripcion,
         MAX(s.un) AS un
  FROM src s
  GROUP BY s.bloque, s.torre, s.piso, s.posicion
  -- Task 18: >= 0 incluye ubicaciones en 0 exacto (se muestran en verde).
  -- Los negativos siguen excluidos (estado de error, no se exhiben).
  HAVING ROUND(SUM(CASE WHEN s.tipo IN ('ingreso','devolucion','traslado','stock_inicial')
                        THEN s.cantidad ELSE -s.cantidad END), 3) >= 0
),
lotes AS (
  SELECT g.bloque, g.torre, g.piso, g.posicion, l.venc, l.cantidad, l.proveedor
  FROM grupos g
  LEFT JOIN LATERAL public.kardex_fefo_descuentos(
    ARRAY(SELECT s.venc FROM src s
          WHERE (s.bloque, s.torre, s.piso, s.posicion) = (g.bloque, g.torre, g.piso, g.posicion)
            AND s.tipo IN ('ingreso','devolucion','traslado','stock_inicial')
            AND s.cantidad > 0
          GROUP BY s.venc ORDER BY s.venc),
    ARRAY(SELECT SUM(s.cantidad) AS qty FROM src s
          WHERE (s.bloque, s.torre, s.piso, s.posicion) = (g.bloque, g.torre, g.piso, g.posicion)
            AND s.tipo IN ('ingreso','devolucion','traslado','stock_inicial')
            AND s.cantidad > 0
          GROUP BY s.venc ORDER BY s.venc),
    ARRAY(SELECT s.venc FROM src s
          WHERE (s.bloque, s.torre, s.piso, s.posicion) = (g.bloque, g.torre, g.piso, g.posicion)
            AND s.tipo NOT IN ('ingreso','devolucion','traslado','stock_inicial')
            AND s.cantidad > 0
          ORDER BY s.f_modificacion, s.id),
    ARRAY(SELECT s.cantidad FROM src s
          WHERE (s.bloque, s.torre, s.piso, s.posicion) = (g.bloque, g.torre, g.piso, g.posicion)
            AND s.tipo NOT IN ('ingreso','devolucion','traslado','stock_inicial')
            AND s.cantidad > 0
          ORDER BY s.f_modificacion, s.id),
    ARRAY(SELECT s.venc FROM src s
          WHERE (s.bloque, s.torre, s.piso, s.posicion) = (g.bloque, g.torre, g.piso, g.posicion)
            AND s.tipo IN ('ingreso','devolucion','traslado','stock_inicial')
            AND s.proveedor IS NOT NULL AND btrim(s.proveedor) <> ''
          ORDER BY s.f_modificacion, s.id),
    ARRAY(SELECT s.proveedor FROM src s
          WHERE (s.bloque, s.torre, s.piso, s.posicion) = (g.bloque, g.torre, g.piso, g.posicion)
            AND s.tipo IN ('ingreso','devolucion','traslado','stock_inicial')
            AND s.proveedor IS NOT NULL AND btrim(s.proveedor) <> ''
          ORDER BY s.f_modificacion, s.id)
  ) l ON true
),
head AS (
  SELECT DISTINCT ON (l.bloque, l.torre, l.piso, l.posicion)
         l.bloque, l.torre, l.piso, l.posicion, l.venc, l.proveedor
  FROM lotes l
  ORDER BY l.bloque, l.torre, l.piso, l.posicion,
           (l.venc = '') ASC, l.venc ASC
)
SELECT g.bloque, g.torre, g.piso, g.posicion, g.stock, g.descripcion, g.un,
       h.proveedor, NULLIF(h.venc, '')::date AS f_vencimiento
FROM grupos g
LEFT JOIN head h ON (h.bloque, h.torre, h.piso, h.posicion)
                = (g.bloque, g.torre, g.piso, g.posicion)
ORDER BY CASE WHEN NULLIF(h.venc, '') IS NULL THEN 1 ELSE 0 END,
         NULLIF(h.venc, '')::date,
         COALESCE(NULLIF(regexp_replace(g.bloque, '[^0-9]', '', 'g'), '')::numeric, 0),
         COALESCE(NULLIF(regexp_replace(g.torre, '[^0-9]', '', 'g'), '')::numeric, 0),
         COALESCE(NULLIF(regexp_replace(g.piso,  '[^0-9]', '', 'g'), '')::numeric, 0),
         COALESCE(NULLIF(regexp_replace(g.posicion, '[^0-9]', '', 'g'), '')::numeric, 0),
         g.bloque, g.torre, g.piso, g.posicion;
$function$;
