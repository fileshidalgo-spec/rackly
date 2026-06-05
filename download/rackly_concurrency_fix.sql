-- ═══════════════════════════════════════════════════════════════
-- JHIA-79: Fix concurrencia — Movimientos atómicos con advisory locks
-- ═══════════════════════════════════════════════════════════════
-- Problema: Cuando 2+ usuarios hacen movimientos al mismo tiempo,
-- el stock se calcula mal porque no hay locks ni validación en servidor.
--
-- Solución:
-- 1. RPC atómica con pg_advisory_xact_lock para cada ubicación
-- 2. Validación de stock en servidor antes de permitir salida
-- 3. Traslado atómico que lockea origen Y destino
-- 4. Índices para mejorar rendimiento de queries de stock
-- 5. Fix CHECK constraint para incluir 'traslado'
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Fix CHECK constraint: incluir 'traslado' ───
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


-- ─── 2. Índices para mejorar queries de stock ───
CREATE INDEX IF NOT EXISTS idx_movimientos_ubicacion
  ON public.movimientos (bloque, torre, piso, posicion, codigo);

CREATE INDEX IF NOT EXISTS idx_movimientos_codigo
  ON public.movimientos (codigo);

CREATE INDEX IF NOT EXISTS idx_movimientos_fmod
  ON public.movimientos (f_modificacion DESC);


-- ─── 3. RPC atómica para registrar movimiento individual ───
-- Usa advisory lock por ubicación+codigo para evitar race conditions.
-- Valida que una salida no exceda el stock disponible.
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


-- ─── 4. RPC atómica para traslado (salida en origen + ingreso en destino) ───
-- Lockea AMBAS ubicaciones en orden alfabético para prevenir deadlocks.
-- Valida que haya stock suficiente en origen.
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


-- ─── 5. Verificar la instalación ───
DO $$
BEGIN
  RAISE NOTICE '✅ JHIA-79 concurrencia: Todas las funciones instaladas correctamente';
  RAISE NOTICE '   - registrar_movimiento_kardex: movimientos atómicos con advisory lock';
  RAISE NOTICE '   - registrar_traslado_kardex: traslados atómicos con double lock';
  RAISE NOTICE '   - Índices creados para performance';
  RAISE NOTICE '   - CHECK constraint incluye traslado';
END $$;
