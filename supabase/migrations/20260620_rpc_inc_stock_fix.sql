-- ═══════════════════════════════════════════════════════════════
-- Migration: RPC fixes for INC stock exclusion + traslado idempotency
-- Fecha: 2026-06-20
-- 
-- 1. registrar_movimiento_kardex: EXCLUIR INC del cálculo de stock
--    para salidas normales (misma lógica que el display en TS).
--    Esto resuelve el bug principal: artículos aparecen después de salida
--    porque el RPC contaba stock INC como stock normal.
--
-- 2. registrar_traslado_kardex: Agregar p_uuid_sync para idempotencia.
--
-- IMPORTANTE: Estas RPCs reemplazan las de 20260611_add_codigo_inc_to_rpcs.sql
-- que NO excluían INC del stock para salidas normales.
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Update registrar_movimiento_kardex ───
-- Stock para salidas NORMALES (no INC) debe excluir movimientos INC.
-- Los INC items son tipo 'ingreso' y no se deben contar como stock
-- disponible para salidas normales del mismo código.
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
  p_proveedor TEXT,
  p_uuid_sync TEXT DEFAULT NULL,
  p_codigo_inc TEXT DEFAULT NULL
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

  -- Calcular stock actual de forma atómica (dentro del lock).
  -- Para salidas NORMALES (sin codigo_inc): excluir movimientos INC del stock.
  -- Los INC items NO cuentan como stock disponible para salidas normales.
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
    AND codigo = v_codigo_clean
    -- Excluir INC del stock solo para salidas normales (no INC)
    AND (p_tipo != 'salida' OR p_codigo_inc IS NOT NULL OR codigo_inc IS NULL);

  -- Validar: salidas no pueden exceder el stock disponible
  IF p_tipo = 'salida' AND p_codigo_inc IS NULL AND p_cantidad > v_current_stock THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK|Stock actual = % %, cantidad solicitada = %',
      v_current_stock, COALESCE(p_un, ''), p_cantidad;
  END IF;

  -- Insertar el movimiento (incluye codigo_inc y uuid_sync)
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, uuid_sync, codigo_inc)
  VALUES (
    p_tipo, p_bloque, p_torre, p_piso, p_posicion, v_codigo_clean,
    p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_uuid_sync, p_codigo_inc
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


-- ─── 2. Update registrar_traslado_kardex con p_uuid_sync ───
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
  p_cantidad_ajuste NUMERIC DEFAULT 0,
  p_codigo_inc TEXT DEFAULT NULL,
  p_uuid_sync TEXT DEFAULT NULL
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

  -- Prevenir traslado a la misma ubicación
  IF p_orig_bloque = p_dest_bloque AND p_orig_torre = p_dest_torre 
     AND p_orig_piso = p_dest_piso AND p_orig_pos = p_dest_pos THEN
    RAISE EXCEPTION 'SAME_ORIGIN_DESTINATION|El destino no puede ser igual al origen';
  END IF;

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

  -- Calcular stock en origen (excluir INC si el traslado no es INC)
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
    AND codigo = v_codigo_clean
    -- Excluir INC del stock para traslados normales
    AND (p_codigo_inc IS NOT NULL OR codigo_inc IS NULL);

  -- Validar stock suficiente en origen
  IF p_cantidad > v_orig_stock THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK_ORIGIN|Stock en origen = % %, cantidad a trasladar = %',
      v_orig_stock, COALESCE(p_un, ''), p_cantidad;
  END IF;

  -- Insertar ajuste si es necesario
  IF p_cantidad_ajuste IS NOT NULL AND p_cantidad_ajuste != 0 THEN
    INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
      cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync)
    VALUES (
      CASE WHEN p_cantidad_ajuste > 0 THEN 'ingreso' ELSE 'salida' END,
      p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
      v_codigo_clean, p_descripcion, p_un,
      ABS(p_cantidad_ajuste),
      p_f_vencimiento, p_turno, p_usuario_id,
      p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc, p_uuid_sync
    );
  END IF;

  -- Insertar salida en origen
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync)
  VALUES (
    'salida', p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc, p_uuid_sync
  );

  -- Insertar traslado (ingreso) en destino
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync)
  VALUES (
    'traslado', p_dest_bloque, p_dest_torre, p_dest_piso, p_dest_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc, p_uuid_sync
  );

  RETURN jsonb_build_object(
    'success', true,
    'origin_previous_stock', v_orig_stock,
    'origin_new_stock', v_orig_stock - p_cantidad + COALESCE(p_cantidad_ajuste, 0)
  );
END;
$$;


-- ─── 3. Verification ───
SELECT 'RPCs actualizadas: INC excluido del stock para salidas normales + uuid_sync en traslado' AS status;
SELECT proname, pronargs
FROM pg_proc
WHERE proname = 'registrar_movimiento_kardex'
  AND pronamespace = 'public'::regnamespace;

SELECT proname, pronargs
FROM pg_proc
WHERE proname = 'registrar_traslado_kardex'
  AND pronamespace = 'public'::regnamespace;
