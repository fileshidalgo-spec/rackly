-- ═══════════════════════════════════════════════════════════════════════
-- DIAGNÓSTICO + FIX COMPLETO — Ocupación de celdas
-- Fecha: 2026-06-24
-- Ejecutar en: Supabase → SQL Editor (pégalo todo y clic "Run")
-- ═══════════════════════════════════════════════════════════════════════

-- ─── PARTE 1: DIAGNÓSTICO ─────────────────────────────────────────
-- Esto muestra qué hay realmente en la tabla movimientos por bloque.

SELECT 'DIAGNÓSTICO' AS seccion, NULL AS detalle;
SELECT NULL AS "---";

-- 1a. Total de movimientos por bloque
SELECT '1. Total movimientos por bloque' AS query;
SELECT
  bloque,
  COUNT(*) AS total_movs,
  COUNT(*) FILTER (WHERE codigo_inc IS NULL) AS sin_inc,
  COUNT(*) FILTER (WHERE codigo_inc IS NOT NULL) AS con_inc
FROM movimientos
GROUP BY bloque
ORDER BY bloque;

-- 1b. Celdas con stock > 0 por bloque (misma lógica que el RPC)
SELECT '2. Celdas con stock neto > 0 por bloque' AS query;
SELECT
  bloque,
  COUNT(*) AS celdas_con_stock,
  SUM(stock_neto) AS total_unidades
FROM (
  SELECT
    m.bloque,
    m.torre, m.piso, m.posicion,
    SUM(CASE
      WHEN m.tipo IN ('ingreso','devolucion','traslado') THEN m.cantidad
      WHEN m.tipo = 'salida' THEN -m.cantidad
      ELSE 0
    END) AS stock_neto
  FROM movimientos m
  WHERE m.codigo_inc IS NULL
  GROUP BY m.bloque, m.torre, m.piso, m.posicion
  HAVING SUM(CASE
    WHEN m.tipo IN ('ingreso','devolucion','traslado') THEN m.cantidad
    WHEN m.tipo = 'salida' THEN -m.cantidad
    ELSE 0
  END) > 0
) sub
GROUP BY bloque
ORDER BY bloque;

-- 1c. Muestra de movimientos en bloques 8 y 9
SELECT '3. Muestra movimientos bloques 8 y 9 (primeras 10)' AS query;
SELECT bloque, torre, piso, posicion, tipo, codigo, cantidad, codigo_inc
FROM movimientos
WHERE bloque IN ('8','9')
ORDER BY f_modificacion DESC
LIMIT 10;

-- 1d. Qué versión del RPC está desplegada actualmente
SELECT '4. Versión actual del RPC (verificar si existe)' AS query;
SELECT
  routine_name,
  routine_definition::text LIKE '%codigo_inc IS NULL%' AS filtra_inc,
  length(routine_definition::text) AS sql_length
FROM information_schema.routines
WHERE routine_name = 'ocupacion_celdas_v2'
  AND routine_schema = 'public';

-- 1e. Si el RPC existe, qué retorna por bloque
SELECT '5. RPC actual: celdas por bloque' AS query;
SELECT bloque, COUNT(*) AS celdas_rpc
FROM ocupacion_celdas_v2()
GROUP BY bloque
ORDER BY bloque;


-- ─── PARTE 2: FIX — Recrear el RPC correctamente ─────────────────

SELECT NULL AS "---";
SELECT 'FIX: Recreando funcion ocupacion_celdas_v2...' AS seccion;

DROP FUNCTION IF EXISTS public.ocupacion_celdas_v2() CASCADE;

CREATE OR REPLACE FUNCTION public.ocupacion_celdas_v2()
RETURNS TABLE (
  bloque text,
  torre text,
  piso text,
  posicion text,
  stock bigint,
  codigos text[],
  lotes bigint
) AS $$
WITH stock_por_codigo AS (
  SELECT
    m.bloque,
    m.torre,
    m.piso,
    m.posicion,
    UPPER(TRIM(m.codigo)) AS codigo,
    SUM(
      CASE
        WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad
        WHEN m.tipo = 'salida' THEN -m.cantidad
        ELSE 0
      END
    )::bigint AS codigo_stock
  FROM movimientos m
  WHERE m.codigo_inc IS NULL
  GROUP BY m.bloque, m.torre, m.piso, m.posicion, UPPER(TRIM(m.codigo))
  HAVING SUM(
    CASE
      WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad
      WHEN m.tipo = 'salida' THEN -m.cantidad
      ELSE 0
    END
  ) > 0
),
stock_agregado AS (
  SELECT
    bloque, torre, piso, posicion,
    SUM(codigo_stock)::bigint AS stock,
    ARRAY_AGG(DISTINCT codigo ORDER BY codigo) AS codigos,
    COUNT(DISTINCT codigo) AS num_codigos
  FROM stock_por_codigo
  GROUP BY bloque, torre, piso, posicion
)
SELECT
  sa.bloque,
  sa.torre,
  sa.piso,
  sa.posicion,
  sa.stock,
  sa.codigos,
  sa.num_codigos AS lotes
FROM stock_agregado sa
ORDER BY sa.bloque, sa.torre, sa.piso, sa.posicion;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION public.ocupacion_celdas_v2() TO anon, authenticated, service_role;


-- ─── PARTE 3: VERIFICACIÓN FINAL ──────────────────────────────────

SELECT NULL AS "---";
SELECT 'VERIFICACION FINAL' AS seccion;

SELECT bloque, COUNT(*) AS celdas, SUM(stock) AS total_unidades
FROM ocupacion_celdas_v2()
GROUP BY bloque
ORDER BY bloque;

SELECT 'Listo. Copia estos resultados y pégalos en el chat.' AS instrucciones;