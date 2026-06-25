-- ═══════════════════════════════════════════════════════════
-- DIAGNÓSTICO: Cross-section Kardex Piso ↔ Racks
-- Ejecutar en Supabase Dashboard → SQL Editor
-- Este SQL NO modifica nada, solo lee datos para diagnóstico.
-- ═══════════════════════════════════════════════════════════

-- 1) ¿Cuántos bloques hay registrados en Piso?
SELECT 'piso_bloques' AS tabla, COUNT(*) AS total_registros
FROM piso_bloques;

-- 2) ¿Cómo se ven los códigos en piso_bloques? (primeros 20)
SELECT id, codigo, descripcion, unidad
FROM piso_bloques
ORDER BY created_at DESC
LIMIT 20;

-- 3) ¿Existe el código "122" (CITRATO DE SODIO) en piso_bloques?
SELECT id, codigo, descripcion, unidad
FROM piso_bloques
WHERE codigo ILIKE '%122%';

-- 4) ¿Cuántos detalles de movimiento hay en Piso?
SELECT 'piso_movimiento_detalles' AS tabla, COUNT(*) AS total_registros
FROM piso_movimiento_detalles;

-- 5) ¿Qué tipo de dato es bloque_id en piso_movimiento_detalles?
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_name = 'piso_movimiento_detalles'
  AND column_name = 'bloque_id';

-- 6) ¿Cómo se ven los bloque_id en los detalles? (primeros 10 distintos)
SELECT DISTINCT bloque_id
FROM piso_movimiento_detalles
LIMIT 10;

-- 7) ¿Hay movimientos de Piso con stock positivo?
SELECT
  d.bloque_id,
  b.codigo AS bloque_codigo,
  b.descripcion,
  d.nivel_id,
  SUM(CASE WHEN m.tipo IN ('ingreso','stock_inicial','devolucion') THEN d.cantidad ELSE 0 END) AS total_ingresos,
  SUM(CASE WHEN m.tipo IN ('salida','traslado') THEN d.cantidad ELSE 0 END) AS total_salidas,
  SUM(CASE WHEN m.tipo IN ('ingreso','stock_inicial','devolucion') THEN d.cantidad ELSE 0 END)
  - SUM(CASE WHEN m.tipo IN ('salida','traslado') THEN d.cantidad ELSE 0 END) AS stock_neto
FROM piso_movimiento_detalles d
LEFT JOIN piso_movimientos m ON m.id = d.movimiento_id
LEFT JOIN piso_bloques b ON b.id = d.bloque_id
GROUP BY d.bloque_id, b.codigo, b.descripcion, d.nivel_id
HAVING SUM(CASE WHEN m.tipo IN ('ingreso','stock_inicial','devolucion') THEN d.cantidad ELSE 0 END)
   - SUM(CASE WHEN m.tipo IN ('salida','traslado') THEN d.cantidad ELSE 0 END) > 0
ORDER BY stock_neto DESC
LIMIT 20;

-- 8) ¿Hay RLS (Row Level Security) activa en las tablas de Piso?
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies
WHERE tablename IN ('piso_bloques', 'piso_movimiento_detalles', 'piso_movimientos',
                    'piso_niveles', 'piso_posiciones', 'piso_subcolumnas', 'piso_columnas', 'piso_sectores');
