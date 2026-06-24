-- ═══════════════════════════════════════════════════════════════════════
-- DIAGNÓSTICO + FIX — Bug "Stock insuficiente" en Salidas
-- Fecha: 2026-06-24
-- Ejecutar en: Supabase → SQL Editor (pégalo todo y clic "Run")
-- ═══════════════════════════════════════════════════════════════════════

-- ─── PARTE 1: DIAGNÓSTICO ──────────────────────────────────────────
-- Verificar si hay formatos mixtos en la BD

SELECT 'DIAGNOSTICO: Formatos de ubicacion en la BD' AS seccion;

-- 1. Verificar si hay formatos mixtos (con y sin ceros)
SELECT '1. Formatos mixtos en torre/piso/posicion' AS query;
SELECT
  bloque,
  COUNT(*) FILTER (WHERE torre ~ '^[0-9]+$' AND LENGTH(torre) = 1) AS torre_sin_cero,
  COUNT(*) FILTER (WHERE torre ~ '^0[0-9]+$') AS torre_con_cero,
  COUNT(*) FILTER (WHERE piso ~ '^[0-9]+$' AND LENGTH(piso) = 1) AS piso_sin_cero,
  COUNT(*) FILTER (WHERE piso ~ '^0[0-9]+$') AS piso_con_cero,
  COUNT(*) FILTER (WHERE posicion ~ '^[0-9]+$' AND LENGTH(posicion) = 1) AS pos_sin_cero,
  COUNT(*) FILTER (WHERE posicion ~ '^0[0-9]+$') AS pos_con_cero
FROM movimientos
GROUP BY bloque
ORDER BY bloque;

-- 2. Verificar si hay movimientos tipo 'stock_inicial'
SELECT '2. Movimientos tipo stock_inicial' AS query;
SELECT
  bloque, torre, piso, posicion, codigo, tipo, cantidad,
  'Este tipo NO es contado por la RPC como stock!' AS nota
FROM movimientos
WHERE tipo = 'stock_inicial'
ORDER BY bloque, torre, piso, posicion
LIMIT 20;

-- 3. Simular lo que la RPC calcula vs lo que el cliente ve
-- Para una muestra de celdas con stock
SELECT '3. Diferencia RPC vs Client-side (muestra 10 celdas)' AS query;
SELECT
  m.bloque, m.torre, m.piso, m.posicion, m.codigo,
  SUM(CASE
    WHEN m.tipo IN ('ingreso','devolucion','traslado') THEN m.cantidad
    WHEN m.tipo = 'salida' THEN -m.cantidad
    ELSE 0  -- stock_inicial cae aqui: se ignora
  END) AS stock_rpc,
  SUM(CASE
    WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad
    WHEN m.tipo = 'salida' THEN -m.cantidad
    ELSE 0
  END) AS stock_con_stock_inicial,
  SUM(m.cantidad) AS suma_bruta
FROM movimientos m
WHERE m.codigo_inc IS NULL
GROUP BY m.bloque, m.torre, m.piso, m.posicion, m.codigo
HAVING SUM(CASE
  WHEN m.tipo IN ('ingreso','devolucion','traslado') THEN m.cantidad
  WHEN m.tipo = 'salida' THEN -m.cantidad
  ELSE 0
END) > 0
ORDER BY m.bloque, m.torre, m.piso, m.posicion
LIMIT 10;

-- 4. Que version de la RPC esta desplegada
SELECT '4. Version de registrar_movimiento_kardex' AS query;
SELECT
  routine_name,
  routine_definition::text LIKE '%stock_inicial%' AS incluye_stock_inicial,
  routine_definition::text LIKE '%codigo_inc IS NULL%' AS filtra_inc,
  routine_definition::text LIKE '%LPAD%' AS tiene_lpad,
  length(routine_definition::text) AS sql_length
FROM information_schema.routines
WHERE routine_name = 'registrar_movimiento_kardex'
  AND routine_schema = 'public';

SELECT 'Copia estos resultados y pegalos en el chat.' AS instrucciones;