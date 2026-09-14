-- ═══════════════════════════════════════════════════════════════════════
-- LOTE + FIX TRASLADO UUID_SYNC — 2026-09-15
-- Aplicado y verificado en produccion (Management API) el 2026-09-15.
-- ═══════════════════════════════════════════════════════════════════════
-- RESUELVE:
-- 1. Campo LOTE para ingresos/salidas/traslados (columna + RPCs v2).
-- 2. Error 42725 "function name is not unique": el GRANT sin lista de
--    argumentos falla cuando coexisten sobrecargas viejas (17/21 params,
--    pre-lote) y nuevas (18/22 params). FIX: DROP IF EXISTS con firma
--    explicita + GRANT con firma explicita.
-- 3. Error 23505 duplicate uuid_sync: registrar_traslado_kardex insertaba
--    la salida y el traslado con el MISMO p_uuid_sync, violando el indice
--    unico parcial idx_movimientos_uuid_sync_unique cuando p_uuid_sync
--    IS NOT NULL. FIX: solo la PRIMERA fila (ajuste si existe, si no la
--    salida) lleva uuid_sync; las demas van con NULL. Mismo criterio que
--    el fallback del frontend (src/lib/rackly/kardex.ts).
-- 4. Mantiene fixes previos: TRIM(LEADING '0' ...) para '01'=='1',
--    stock_inicial suma stock, exclusion INC, advisory locks,
--    NULLIF(TRIM(p_lote),'') al guardar el lote.
-- ═══════════════════════════════════════════════════════════════════════

-- ── BLOQUE A: columna lote (idempotente) ────────────────────────────────

ALTER TABLE public.movimientos ADD COLUMN IF NOT EXISTS lote TEXT;

COMMENT ON COLUMN public.movimientos.lote IS
  'Codigo fisico de lote digitado en el ingreso (NULL si no aplica)';

-- ── BLOQUE B: limpiar sobrecargas viejas (evita el 42725) ──────────────
-- Firma vieja de registrar_movimiento_kardex (17 params, sin p_lote):
DROP FUNCTION IF EXISTS public.registrar_movimiento_kardex(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, DATE, TEXT,
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT);

-- Firma vieja de registrar_traslado_kardex (21 params, sin p_lote):
DROP FUNCTION IF EXISTS public.registrar_traslado_kardex(
  TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, UUID, TEXT, TEXT, DATE, TEXT, NUMERIC, TEXT, TEXT);

-- ── BLOQUE C: registrar_movimiento_kardex v2 (18 params, con p_lote) ───

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
  p_codigo_inc TEXT DEFAULT NULL,
  p_lote TEXT DEFAULT NULL
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
  -- Normalizar codigo
  v_codigo_clean := UPPER(TRIM(p_codigo));

  -- Advisory lock por ubicacion + codigo (se libera al terminar la transaccion)
  v_loc_key := p_bloque || '/' || p_torre || '/' || p_piso || '/' || p_posicion || '/' || v_codigo_clean;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_loc_key, 0));

  -- Stock actual normalizando ubicacion (fix '01' vs '1') y contando stock_inicial
  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
      WHEN tipo = 'salida' THEN -cantidad
      ELSE 0
    END
  ), 0) INTO v_current_stock
  FROM movimientos
  WHERE bloque = p_bloque
    AND TRIM(LEADING '0' FROM torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
    AND TRIM(LEADING '0' FROM piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
    AND TRIM(LEADING '0' FROM posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
    AND codigo = v_codigo_clean
    -- Excluir INC del stock para salidas normales (no INC)
    AND (p_tipo != 'salida' OR p_codigo_inc IS NOT NULL OR codigo_inc IS NULL);

  -- Validar: salidas no pueden exceder el stock disponible
  IF p_tipo = 'salida' AND p_codigo_inc IS NULL AND p_cantidad > v_current_stock THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK|Stock actual = % %, cantidad solicitada = %',
      v_current_stock, COALESCE(p_un, ''), p_cantidad;
  END IF;

  -- Insertar el movimiento (lote = codigo fisico digitado, limpio; NULL si viene vacio)
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, uuid_sync, codigo_inc, lote)
  VALUES (
    p_tipo, p_bloque, p_torre, p_piso, p_posicion, v_codigo_clean,
    p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_uuid_sync, p_codigo_inc,
    NULLIF(TRIM(p_lote), '')
  );

  RETURN jsonb_build_object(
    'success', true,
    'previous_stock', v_current_stock,
    'new_stock', v_current_stock + CASE
      WHEN p_tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN p_cantidad
      ELSE -p_cantidad
    END
  );
END;
$$;

-- ── BLOQUE D: registrar_traslado_kardex v2 (22 params, con p_lote) ─────
-- Incluye FIX uuid_sync: solo la primera fila lleva uuid_sync.

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
  p_uuid_sync TEXT DEFAULT NULL,
  p_lote TEXT DEFAULT NULL
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
  v_codigo_clean := UPPER(TRIM(p_codigo));

  IF p_orig_bloque = p_dest_bloque AND p_orig_torre = p_dest_torre
     AND p_orig_piso = p_dest_piso AND p_orig_pos = p_dest_pos THEN
    RAISE EXCEPTION 'SAME_ORIGIN_DESTINATION|El destino no puede ser igual al origen';
  END IF;

  v_orig_key := p_orig_bloque || '/' || p_orig_torre || '/' || p_orig_piso || '/' || p_orig_pos || '/' || v_codigo_clean;
  v_dest_key := p_dest_bloque || '/' || p_dest_torre || '/' || p_dest_piso || '/' || p_dest_pos || '/' || v_codigo_clean;

  IF v_orig_key < v_dest_key THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_orig_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(v_dest_key, 0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(v_dest_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(v_orig_key, 0));
  END IF;

  -- Stock en origen normalizando ubicacion ('01' == '1') + contando stock_inicial
  -- + excluyendo INC para traslados normales
  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
      WHEN tipo = 'salida' THEN -cantidad
      ELSE 0
    END
  ), 0) INTO v_orig_stock
  FROM movimientos
  WHERE bloque = p_orig_bloque
    AND TRIM(LEADING '0' FROM torre) = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
    AND TRIM(LEADING '0' FROM piso) = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
    AND TRIM(LEADING '0' FROM posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
    AND codigo = v_codigo_clean
    AND (p_codigo_inc IS NOT NULL OR codigo_inc IS NULL);

  IF p_cantidad > v_orig_stock THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK_ORIGIN|Stock en origen = % %, cantidad a trasladar = %',
      v_orig_stock, COALESCE(p_un, ''), p_cantidad;
  END IF;

  -- ═══ FIX idx_movimientos_uuid_sync_unique ═══
  -- Solo la PRIMERA fila del traslado lleva uuid_sync (idempotencia):
  --   * ajuste (si existe)      -> p_uuid_sync
  --   * salida                  -> p_uuid_sync SOLO si no hubo ajuste
  --   * traslado (destino)      -> NULL siempre
  -- Igual criterio que el fallback del frontend (kardex.ts).

  IF p_cantidad_ajuste IS NOT NULL AND p_cantidad_ajuste != 0 THEN
    INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
      cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync, lote)
    VALUES (
      CASE WHEN p_cantidad_ajuste > 0 THEN 'ingreso' ELSE 'salida' END,
      p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
      v_codigo_clean, p_descripcion, p_un,
      ABS(p_cantidad_ajuste),
      p_f_vencimiento, p_turno, p_usuario_id,
      p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc, p_uuid_sync,
      NULLIF(TRIM(p_lote), '')
    );
  END IF;

  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync, lote)
  VALUES (
    'salida', p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc,
    CASE WHEN COALESCE(p_cantidad_ajuste, 0) != 0 THEN NULL ELSE p_uuid_sync END,
    NULLIF(TRIM(p_lote), '')
  );

  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync, lote)
  VALUES (
    'traslado', p_dest_bloque, p_dest_torre, p_dest_piso, p_dest_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc,
    NULL,
    NULLIF(TRIM(p_lote), '')
  );

  RETURN jsonb_build_object(
    'success', true,
    'origin_previous_stock', v_orig_stock,
    'origin_new_stock', v_orig_stock - p_cantidad + COALESCE(p_cantidad_ajuste, 0)
  );
END;
$$;

-- ── BLOQUE E: GRANT con firma explicita (a prueba de 42725) ────────────

GRANT EXECUTE ON FUNCTION public.registrar_movimiento_kardex(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, DATE, TEXT,
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.registrar_traslado_kardex(
  TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, UUID, TEXT, TEXT, DATE, TEXT, NUMERIC, TEXT, TEXT, TEXT)
  TO anon, authenticated, service_role;

-- ── BLOQUE F: verificacion ──────────────────────────────────────────────

SELECT p.proname,
       array_length(p.proargtypes, 1) AS n_args,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.proacl::text AS grants
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('registrar_movimiento_kardex','registrar_traslado_kardex')
ORDER BY p.proname;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'movimientos' AND column_name = 'lote';
