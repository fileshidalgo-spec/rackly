-- ═══════════════════════════════════════════════════════════════════════
-- RACKLY - SQL MASTER: TODO EN UN SOLO SCRIPT
-- Ejecutar TODO en Supabase Dashboard > SQL Editor de una sola vez
-- ═══════════════════════════════════════════════════════════════════════
-- Este script:
-- 1. Agrega columna uuid_sync (para sincronizacion offline)
-- 2. Fix CHECK constraint para incluir 'traslado' y 'devolucion'
-- 3. Crea/actualiza registrar_movimiento_kardex (RPC atómica con advisory lock)
-- 4. Crea/actualiza registrar_traslado_kardex (RPC atómica con double lock)
-- 5. Crea/actualiza stock_en_ubicacion (incluye 'traslado')
-- 6. Crea/actualiza ocupacion_celdas (incluye 'traslado')
-- 7. Crea índices de performance
-- 8. Cambia volatilidad a VOLATILE para datos frescos
-- ═══════════════════════════════════════════════════════════════════════


-- ─── 1. Agregar columna uuid_sync para sincronización offline ───
ALTER TABLE public.movimientos
  ADD COLUMN IF NOT EXISTS uuid_sync TEXT;

-- Index para búsquedas rápidas por uuid_sync (deduplicación offline)
CREATE INDEX IF NOT EXISTS idx_movimientos_uuid_sync
  ON public.movimientos (uuid_sync)
  WHERE uuid_sync IS NOT NULL;


-- ─── 2. Fix CHECK constraint: incluir 'traslado' y 'devolucion' ───
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'movimientos_tipo_check'
    AND conrelid = 'public.movimientos'::regclass
  ) THEN
    ALTER TABLE public.movimientos DROP CONSTRAINT movimientos_tipo_check;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE public.movimientos
  ADD CONSTRAINT movimientos_tipo_check
  CHECK (tipo IN ('ingreso','salida','devolucion','traslado'));


-- ─── 3. Índices para mejorar queries de stock ───
CREATE INDEX IF NOT EXISTS idx_movimientos_ubicacion
  ON public.movimientos (bloque, torre, piso, posicion, codigo);

CREATE INDEX IF NOT EXISTS idx_movimientos_codigo
  ON public.movimientos (codigo);

CREATE INDEX IF NOT EXISTS idx_movimientos_fmod
  ON public.movimientos (f_modificacion DESC);


-- ─── 4. RPC: registrar_movimiento_kardex (atómica con advisory lock) ───
-- Valida stock antes de permitir salida. Usa lock por ubicación+código.
-- Parámetros exactamente como los envía el código TypeScript.
CREATE OR REPLACE FUNCTION public.registrar_movimiento_kardex(
  p_tipo TEXT,
  p_bloque TEXT,
  p_torre TEXT,
  p_piso TEXT,
  p_posicion TEXT,
  p_codigo TEXT,
  p_descripcion TEXT,
  p_un TEXT,
  p_cantidad NUMERIC,
  p_f_vencimiento DATE,
  p_turno TEXT,
  p_usuario_id UUID,
  p_usuario_nombre TEXT,
  p_usuario_correo TEXT,
  p_proveedor TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_stock NUMERIC;
  v_loc_key TEXT;
  v_codigo_clean TEXT;
BEGIN
  -- Normalizar código
  v_codigo_clean := UPPER(TRIM(p_codigo));

  -- Advisory lock por ubicación+código (se libera automáticamente al terminar la transacción)
  v_loc_key := p_bloque || '/' || p_torre || '/' || p_piso || '/' || p_posicion || '/' || v_codigo_clean;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_loc_key, 0));

  -- Calcular stock actual de forma atómica (dentro del lock)
  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('ingreso','devolucion','traslado') THEN cantidad
      WHEN tipo = 'salida' THEN -cantidad
      ELSE 0
    END
  ), 0) INTO v_current_stock
  FROM movimientos
  WHERE bloque = p_bloque
    AND torre = p_torre
    AND piso = p_piso
    AND posicion = p_posicion
    AND codigo = v_codigo_clean;

  -- Validar: salidas no pueden exceder el stock disponible
  IF p_tipo = 'salida' AND p_cantidad > v_current_stock THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK|Stock actual = % %, cantidad solicitada = %',
      v_current_stock, COALESCE(p_un, ''), p_cantidad;
  END IF;

  -- Insertar el movimiento
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor)
  VALUES (
    p_tipo, p_bloque, p_torre, p_piso, p_posicion, v_codigo_clean,
    p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor
  );

  -- Retornar resultado
  RETURN jsonb_build_object(
    'success', true,
    'previous_stock', v_current_stock,
    'new_stock', v_current_stock + CASE
      WHEN p_tipo IN ('ingreso','devolucion','traslado') THEN p_cantidad
      ELSE -p_cantidad
    END
  );
END;
$$;


-- ─── 5. RPC: registrar_traslado_kardex (atómica con double lock) ───
-- Lockea AMBAS ubicaciones en orden alfabético para prevenir deadlocks.
-- Valida stock suficiente en origen. Parámetros exactamente como los envía TS.
CREATE OR REPLACE FUNCTION public.registrar_traslado_kardex(
  p_codigo TEXT,
  p_descripcion TEXT,
  p_un TEXT,
  p_cantidad NUMERIC,
  p_orig_bloque TEXT,
  p_orig_torre TEXT,
  p_orig_piso TEXT,
  p_orig_pos TEXT,
  p_dest_bloque TEXT,
  p_dest_torre TEXT,
  p_dest_piso TEXT,
  p_dest_pos TEXT,
  p_turno TEXT,
  p_usuario_id UUID,
  p_usuario_nombre TEXT,
  p_usuario_correo TEXT,
  p_f_vencimiento DATE,
  p_proveedor TEXT,
  p_cantidad_ajuste NUMERIC DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orig_stock NUMERIC;
  v_codigo_clean TEXT;
  v_orig_key TEXT;
  v_dest_key TEXT;
BEGIN
  -- Normalizar código
  v_codigo_clean := UPPER(TRIM(p_codigo));

  -- Lock en orden alfabético para prevenir deadlocks
  v_orig_key := p_orig_bloque || '/' || p_orig_torre || '/' || p_orig_piso || '/' || p_orig_pos || '/' || v_codigo_clean;
  v_dest_key := p_dest_bloque || '/' || p_dest_torre || '/' || p_dest_piso || '/' || p_dest_pos || '/' || v_codigo_clean;

  IF v_orig_key < v_dest_key THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_orig_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(v_dest_key, 0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(v_dest_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(v_orig_key, 0));
  END IF;

  -- Calcular stock en origen
  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('ingreso','devolucion','traslado') THEN cantidad
      WHEN tipo = 'salida' THEN -cantidad
      ELSE 0
    END
  ), 0) INTO v_orig_stock
  FROM movimientos
  WHERE bloque = p_orig_bloque
    AND torre = p_orig_torre
    AND piso = p_orig_piso
    AND posicion = p_orig_pos
    AND codigo = v_codigo_clean;

  -- Validar stock suficiente en origen
  IF p_cantidad > v_orig_stock THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK_ORIGIN|Stock en origen = % %, cantidad a trasladar = %',
      v_orig_stock, COALESCE(p_un, ''), p_cantidad;
  END IF;

  -- Insertar ajuste si es necesario (ingreso/salida para corregir diferencia)
  IF p_cantidad_ajuste IS NOT NULL AND p_cantidad_ajuste != 0 THEN
    INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
      cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor)
    VALUES (
      CASE WHEN p_cantidad_ajuste > 0 THEN 'ingreso' ELSE 'salida' END,
      p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
      v_codigo_clean, p_descripcion, p_un,
      ABS(p_cantidad_ajuste),
      p_f_vencimiento, p_turno, p_usuario_id,
      p_usuario_nombre, p_usuario_correo, p_proveedor
    );
  END IF;

  -- Insertar salida en origen
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor)
  VALUES (
    'salida', p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor
  );

  -- Insertar traslado (ingreso) en destino
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor)
  VALUES (
    'traslado', p_dest_bloque, p_dest_torre, p_dest_piso, p_dest_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor
  );

  RETURN jsonb_build_object(
    'success', true,
    'origin_previous_stock', v_orig_stock,
    'origin_new_stock', v_orig_stock - p_cantidad + COALESCE(p_cantidad_ajuste, 0)
  );
END;
$$;


-- ─── 6. RPC: stock_en_ubicacion (actualizada con 'traslado') ───
CREATE OR REPLACE FUNCTION public.stock_en_ubicacion(
  _bloque TEXT,
  _torre TEXT,
  _piso TEXT,
  _posicion TEXT
)
RETURNS TABLE(
  codigo TEXT,
  descripcion TEXT,
  un TEXT,
  stock NUMERIC,
  f_vencimiento DATE,
  usuario_primer_nombre TEXT,
  proveedor TEXT
)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT 
    m.codigo,
    MAX(m.descripcion) AS descripcion,
    MAX(m.un) AS un,
    SUM(
      CASE 
        WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad 
        WHEN m.tipo = 'salida' THEN -m.cantidad 
        ELSE 0 
      END
    ) AS stock,
    (
      SELECT m2.f_vencimiento
      FROM public.movimientos m2
      WHERE m2.bloque = m.bloque 
        AND m2.torre = m.torre 
        AND m2.piso = m.piso 
        AND m2.posicion = m.posicion 
        AND m2.codigo = m.codigo
        AND m2.tipo IN ('ingreso', 'devolucion', 'traslado')
      ORDER BY m2.f_modificacion DESC
      LIMIT 1
    ) AS f_vencimiento,
    (
      SELECT m3.usuario_nombre
      FROM public.movimientos m3
      WHERE m3.bloque = m.bloque 
        AND m3.torre = m.torre 
        AND m3.piso = m.piso 
        AND m3.posicion = m.posicion 
        AND m3.codigo = m.codigo
      ORDER BY m3.f_modificacion ASC
      LIMIT 1
    ) AS usuario_primer_nombre,
    (
      SELECT m4.proveedor
      FROM public.movimientos m4
      WHERE m4.bloque = m.bloque 
        AND m4.torre = m.torre 
        AND m4.piso = m.piso 
        AND m4.posicion = m.posicion 
        AND m4.codigo = m.codigo
        AND m4.proveedor IS NOT NULL AND m4.proveedor != ''
      ORDER BY m4.f_modificacion DESC
      LIMIT 1
    ) AS proveedor
  FROM public.movimientos m
  WHERE m.bloque = _bloque
    AND m.torre = _torre
    AND m.piso = _piso
    AND m.posicion = _posicion
  GROUP BY m.bloque, m.torre, m.piso, m.posicion, m.codigo
  HAVING SUM(
    CASE 
      WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad 
      WHEN m.tipo = 'salida' THEN -m.cantidad 
      ELSE 0 
    END
  ) > 0
  ORDER BY m.codigo;
$$;


-- ─── 7. RPC: ocupacion_celdas (actualizada con 'traslado') ───
CREATE OR REPLACE FUNCTION public.ocupacion_celdas()
RETURNS TABLE(
  bloque TEXT,
  torre TEXT,
  piso TEXT,
  posicion TEXT,
  stock NUMERIC,
  codigos TEXT[]
)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
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
    ) AS stock,
    ARRAY_AGG(DISTINCT m.codigo) AS codigos
  FROM public.movimientos m
  GROUP BY m.bloque, m.torre, m.piso, m.posicion
  HAVING SUM(
    CASE 
      WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad 
      WHEN m.tipo = 'salida' THEN -m.cantidad 
      ELSE 0 
    END
  ) > 0;
$$;


-- ─── 8. Verificar instalación ───
SELECT '=== VERIFICACION DE INSTALACION ===' AS info;

SELECT proname AS funcion, 
       provolatile::text AS volatilidad,
       prosrc IS NOT NULL AS compilada
FROM pg_proc
WHERE proname IN ('registrar_movimiento_kardex', 'registrar_traslado_kardex', 'stock_en_ubicacion', 'ocupacion_celdas')
  AND pronamespace = 'public'::regnamespace
ORDER BY proname;

SELECT 'Verificacion de indices:' AS info;
SELECT indexname, tablename 
FROM pg_indexes 
WHERE schemaname = 'public' 
  AND indexname LIKE 'idx_movimientos%'
ORDER BY indexname;

SELECT 'Verificacion de constraint:' AS info;
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname = 'movimientos_tipo_check'
  AND conrelid = 'public.movimientos'::regclass;

SELECT 'Verificacion columna uuid_sync:' AS info;
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'movimientos' 
  AND column_name = 'uuid_sync';
