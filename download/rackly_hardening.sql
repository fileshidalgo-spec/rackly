-- ═══════════════════════════════════════════════════════════════
-- Hardening: Fix volatilidad de RPCs + agregar ErrorBoundary por sección
-- ═══════════════════════════════════════════════════════════════
-- Las RPCs stock_en_ubicacion y ocupacion_celdas están declaradas como
-- STABLE, lo que puede causar que PostgreSQL devuelva datos cacheados
-- dentro de una transacción. Cambiamos a VOLATILE para que siempre
-- devuelvan datos frescos.
-- ═══════════════════════════════════════════════════════════════

-- Fix volatilidad de stock_en_ubicacion
DO $$
BEGIN
  -- Intentar cambiar de STABLE a VOLATILE
  ALTER FUNCTION public.stock_en_ubicacion(TEXT, TEXT, TEXT, TEXT) VOLATILE;
  RAISE NOTICE '✅ stock_en_ubicacion cambiada a VOLATILE';
EXCEPTION WHEN OTHERS THEN
  -- Si la función no existe con esa firma exacta, buscar la firma correcta
  BEGIN
    ALTER FUNCTION public.stock_en_ubicacion() VOLATILE;
    RAISE NOTICE '✅ stock_en_ubicacion() cambiada a VOLATILE';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '⚠️ No se pudo cambiar stock_en_ubicacion (puede no existir o tener firma diferente)';
  END;
END $$;

-- Fix volatilidad de ocupacion_celdas
DO $$
BEGIN
  ALTER FUNCTION public.ocupacion_celdas() VOLATILE;
  RAISE NOTICE '✅ ocupacion_celdas cambiada a VOLATILE';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '⚠️ No se pudo cambiar ocupacion_celdas (puede no existir)';
END $$;

-- Verificar estado actual
SELECT proname, provolatile::text
FROM pg_proc
WHERE proname IN ('stock_en_ubicacion', 'ocupacion_celdas', 'registrar_movimiento_kardex', 'registrar_traslado_kardex')
ORDER BY proname;
