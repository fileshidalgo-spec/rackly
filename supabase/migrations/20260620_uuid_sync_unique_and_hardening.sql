-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN: uuid_sync UNIQUE + Verificación de integridad
-- Ejecutar en Supabase Dashboard > SQL Editor
-- ═══════════════════════════════════════════════════════════════
-- 1. UNIQUE partial index en uuid_sync: previene duplicados offline
--    sin bloquear inserts normales (uuid_sync IS NULL).
-- 2. Verifica CHECK constraint incluye los 4 tipos de movimiento.
-- 3. Verifica que las RPCs atómicas están correctamente instaladas.
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. UNIQUE index en uuid_sync (partial: solo filas donde NO es NULL) ───
DROP INDEX IF EXISTS idx_movimientos_uuid_sync;
CREATE UNIQUE INDEX idx_movimientos_uuid_sync_unique
  ON public.movimientos (uuid_sync)
  WHERE uuid_sync IS NOT NULL;


-- ─── 2. Verificar CHECK constraint incluye los 4 tipos ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'movimientos_tipo_check'
    AND conrelid = 'public.movimientos'::regclass
    AND consrc LIKE '%traslado%'
    AND consrc LIKE '%devolucion%'
  ) THEN
    ALTER TABLE public.movimientos DROP CONSTRAINT IF EXISTS movimientos_tipo_check;
    ALTER TABLE public.movimientos
      ADD CONSTRAINT movimientos_tipo_check
      CHECK (tipo IN ('ingreso','salida','devolucion','traslado'));
    RAISE NOTICE 'CHECK constraint actualizada con los 4 tipos de movimiento';
  ELSE
    RAISE NOTICE 'CHECK constraint ya incluye los 4 tipos';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'No se pudo verificar CHECK constraint: %', SQLERRM;
END $$;


-- ─── 3. Verificar RPCs instaladas ───
DO $$
DECLARE
  v_rpc_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_rpc_count
  FROM pg_proc
  WHERE proname IN ('registrar_movimiento_kardex', 'registrar_traslado_kardex', 'stock_en_ubicacion', 'ocupacion_celdas')
    AND pronamespace = 'public'::regnamespace;

  IF v_rpc_count >= 4 THEN
    RAISE NOTICE 'Todas las 4 RPCs están instaladas';
  ELSE
    RAISE WARNING 'Solo % de 4 RPCs instaladas. Ejecutar rackly_MASTER_FIX.sql', v_rpc_count;
  END IF;
END $$;


-- ─── 4. Verificar índices de performance ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_movimientos_ubicacion'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_movimientos_ubicacion
      ON public.movimientos (bloque, torre, piso, posicion, codigo);
    RAISE NOTICE 'Índice idx_movimientos_ubicacion creado';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_movimientos_codigo'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_movimientos_codigo
      ON public.movimientos (codigo);
    RAISE NOTICE 'Índice idx_movimientos_codigo creado';
  END IF;
END $$;


-- ─── 5. Verificar columna uuid_sync y codigo_inc existen ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'movimientos' AND column_name = 'uuid_sync'
  ) THEN
    ALTER TABLE public.movimientos ADD COLUMN uuid_sync TEXT;
    RAISE NOTICE 'Columna uuid_sync agregada';
  ELSE
    RAISE NOTICE 'Columna uuid_sync ya existe';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'movimientos' AND column_name = 'codigo_inc'
  ) THEN
    ALTER TABLE public.movimientos ADD COLUMN codigo_inc TEXT;
    RAISE NOTICE 'Columna codigo_inc agregada';
  ELSE
    RAISE NOTICE 'Columna codigo_inc ya existe';
  END IF;
END $$;


-- ─── Resultado ───
SELECT 'Verificación completada' AS status;
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_movimientos%';
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conname = 'movimientos_tipo_check' AND conrelid = 'public.movimientos'::regclass;
