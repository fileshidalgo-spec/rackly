-- ═══════════════════════════════════════════════════════════════════════
-- FIX COMPLETO — Bug "Stock insuficiente" en Salidas
-- Fecha: 2026-06-24
-- Ejecutar en: Supabase → SQL Editor (pégalo todo y clic "Run")
-- ═══════════════════════════════════════════════════════════════════════
--
-- PROBLEMAS RESUELTOS:
-- 1. La RPC usaba match exacto en torre/piso/posicion.
--    Si la BD tiene '01' y el frontend envia '1', no encontraba stock.
--    FIX: Normalizar con TRIM(lpad en la comparacion.
-- 2. La RPC NO contaba 'stock_inicial' como entrada de stock.
--    Si un producto se cargo con tipo stock_inicial, la RPC veia stock=0.
--    FIX: Agregar stock_inicial a la lista de tipos que suman stock.
-- 3. La RPC vieja (20260611) no excluia INC del calculo de stock.
--    FIX: Mantener la exclusion de INC + los fixes 1 y 2.
--
-- ═══════════════════════════════════════════════════════════════════════

SELECT 'FIX: Actualizando registrar_movimiento_kardex...' AS seccion;

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
  -- Normalizar codigo
  v_codigo_clean := UPPER(TRIM(p_codigo));

  -- Advisory lock por ubicacion + codigo (se libera al terminar la transaccion)
  v_loc_key := p_bloque || '/' || p_torre || '/' || p_piso || '/' || p_posicion || '/' || v_codigo_clean;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_loc_key, 0));

  -- ═══ FIX 1: Normalizar ubicacion para evitar fallos '01' vs '1' ═══
  -- Usar una subquery que normaliza ambos lados de la comparacion
  -- BTRIM elimina espacios, y lpad de 2 digitos (con '0') asegura formato unico
  SELECT COALESCE(SUM(
    CASE
      -- FIX 2: Agregar 'stock_inicial' como tipo que suma stock
      WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
      WHEN tipo = 'salida' THEN -cantidad
      ELSE 0
    END
  ), 0) INTO v_current_stock
  FROM movimientos
  WHERE bloque = p_bloque
    -- Comparacion normalizada: eliminar ceros a la izquierda de AMBOS lados
    AND BTRIM(LEADING '0' FROM torre) = BTRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
    AND BTRIM(LEADING '0' FROM piso) = BTRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
    AND BTRIM(LEADING '0' FROM posicion) = BTRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
    AND codigo = v_codigo_clean
    -- FIX 3: Excluir INC del stock para salidas normales (no INC)
    AND (p_tipo != 'salida' OR p_codigo_inc IS NOT NULL OR codigo_inc IS NULL);

  -- Validar: salidas no pueden exceder el stock disponible
  IF p_tipo = 'salida' AND p_codigo_inc IS NULL AND p_cantidad > v_current_stock THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK|Stock actual = % %, cantidad solicitada = %',
      v_current_stock, COALESCE(p_un, ''), p_cantidad;
  END IF;

  -- Insertar el movimiento
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, uuid_sync, codigo_inc)
  VALUES (
    p_tipo, p_bloque, p_torre, p_piso, p_posicion, v_codigo_clean,
    p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_uuid_sync, p_codigo_inc
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

-- ═══ Tambien actualizar registrar_traslado_kardex con los mismos fixes ═══

SELECT 'FIX: Actualizando registrar_traslado_kardex...' AS seccion;

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

  -- FIX 1+2: Normalizar ubicacion + contar stock_inicial
  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
      WHEN tipo = 'salida' THEN -cantidad
      ELSE 0
    END
  ), 0) INTO v_orig_stock
  FROM movimientos
  WHERE bloque = p_orig_bloque
    AND BTRIM(LEADING '0' FROM torre) = BTRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
    AND BTRIM(LEADING '0' FROM piso) = BTRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
    AND BTRIM(LEADING '0' FROM posicion) = BTRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
    AND codigo = v_codigo_clean
    -- FIX 3: Excluir INC del stock para traslados normales
    AND (p_codigo_inc IS NOT NULL OR codigo_inc IS NULL);

  IF p_cantidad > v_orig_stock THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK_ORIGIN|Stock en origen = % %, cantidad a trasladar = %',
      v_orig_stock, COALESCE(p_un, ''), p_cantidad;
  END IF;

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

  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync)
  VALUES (
    'salida', p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc, p_uuid_sync
  );

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

-- ═══ Tambien actualizar ocupacion_celdas_v2 para contar stock_inicial ═══

SELECT 'FIX: Actualizando ocupacion_celdas_v2...' AS seccion;

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
        WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado', 'stock_inicial') THEN m.cantidad
        WHEN m.tipo = 'salida' THEN -m.cantidad
        ELSE 0
      END
    )::bigint AS codigo_stock
  FROM movimientos m
  WHERE m.codigo_inc IS NULL
  GROUP BY m.bloque, m.torre, m.piso, m.posicion, UPPER(TRIM(m.codigo))
  HAVING SUM(
    CASE
      WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado', 'stock_inicial') THEN m.cantidad
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


-- ═══ VERIFICACION ═══

SELECT NULL AS "---";
SELECT 'VERIFICACION FINAL' AS seccion;

SELECT '1. registrar_movimiento_kardex' AS rpc;
SELECT
  routine_name,
  routine_definition::text LIKE '%stock_inicial%' AS incluye_stock_inicial,
  routine_definition::text LIKE '%LEADING ''0''%' AS normaliza_ubicacion,
  routine_definition::text LIKE '%codigo_inc IS NULL%' AS filtra_inc,
  length(routine_definition::text) AS sql_length
FROM information_schema.routines
WHERE routine_name = 'registrar_movimiento_kardex'
  AND routine_schema = 'public';

SELECT '2. ocupacion_celdas_v2' AS rpc;
SELECT
  routine_name,
  routine_definition::text LIKE '%stock_inicial%' AS incluye_stock_inicial,
  length(routine_definition::text) AS sql_length
FROM information_schema.routines
WHERE routine_name = 'ocupacion_celdas_v2'
  AND routine_schema = 'public';

SELECT '3. Celdas por bloque' AS verify;
SELECT bloque, COUNT(*) AS celdas, SUM(stock) AS total_unidades
FROM ocupacion_celdas_v2()
GROUP BY bloque
ORDER BY bloque;

SELECT 'Listo. Todos los fixes aplicados.' AS instrucciones;