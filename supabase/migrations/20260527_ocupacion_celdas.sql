-- ═══════════════════════════════════════════════════════════════
-- Función: ocupacion_celdas()
-- Propósito: Calcular stock y códigos por celda de forma eficiente
--            en la base de datos, evitando descargar todos los
--            movimientos al navegador.
-- Escalabilidad: Funciona con millones de registros sin degradación.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.ocupacion_celdas()
RETURNS TABLE (
  bloque text,
  torre text,
  piso text,
  posicion text,
  stock bigint,
  codigos text[]
) AS $$
WITH stock_agregado AS (
  SELECT
    m.bloque,
    m.torre,
    m.piso,
    m.posicion,
    SUM(
      CASE
        WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad
        WHEN m.tipo = 'salida' THEN -m.cantidad
        ELSE 0
      END
    )::bigint AS stock
  FROM movimientos m
  GROUP BY m.bloque, m.torre, m.piso, m.posicion
),
codigos_por_celda AS (
  SELECT
    sa.bloque,
    sa.torre,
    sa.piso,
    sa.posicion,
    sa.stock,
    ARRAY_AGG(DISTINCT UPPER(TRIM(m.codigo))) AS codigos
  FROM stock_agregado sa
  JOIN movimientos m
    ON m.bloque = sa.bloque
   AND m.torre = sa.torre
   AND m.piso = sa.piso
   AND m.posicion = sa.posicion
   AND m.tipo IN ('ingreso', 'devolucion', 'traslado')
  WHERE sa.stock > 0
  GROUP BY sa.bloque, sa.torre, sa.piso, sa.posicion, sa.stock
)
SELECT
  sa.bloque,
  sa.torre,
  sa.piso,
  sa.posicion,
  sa.stock,
  COALESCE(cc.codigos, ARRAY[]::text[]) AS codigos
FROM stock_agregado sa
LEFT JOIN codigos_por_celda cc
  ON cc.bloque = sa.bloque
 AND cc.torre = sa.torre
 AND cc.piso = sa.piso
 AND cc.posicion = sa.posicion
ORDER BY sa.bloque, sa.torre, sa.piso, sa.posicion;
$$ LANGUAGE sql STABLE;

-- ═══════════════════════════════════════════════════════════════
-- Permitir acceso público (anon) a la función
-- ═══════════════════════════════════════════════════════════════
GRANT EXECUTE ON FUNCTION public.ocupacion_celdas() TO anon, authenticated, service_role;
