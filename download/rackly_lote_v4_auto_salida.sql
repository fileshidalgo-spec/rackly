-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY · rackly_lote_v4_auto_salida.sql
-- Prevención de "negativos por lote" (los 719): auto-asignación FEFO de lote
-- físico en las SALIDAS que llegan sin p_lote.
--
-- PROBLEMA (diagnóstico 16-oct-2026):
--   740 celdas (ubicación+código+lote) con stock neto negativo. 739 eran
--   artefactos de atribución: salidas registradas con lote NULL sobre celdas
--   cuyos ingresos SÍ tienen lote físico. Crecían ~25/día (93% de las salidas
--   de los últimos días nacían sin lote). Se reparó el histórico por backfill;
--   este script cierra el cauce para que no vuelva a ocurrir.
--
-- SOLUCIÓN:
--   registrar_movimiento_kardex v3 y registrar_traslado_kardex v3:
--   cuando la fila de SALIDA (pool normal, sin INC) llega sin p_lote, la RPC
--   busca un lote físico de la celda cuyo saldo por lote cubra la cantidad y
--   se lo asigna (orden FEFO: menor fecha de vencimiento primero, luego el
--   ingreso más antiguo). Si ningún lote cubre sola, asigna el de mayor saldo
--   (mejor aproximación a una salida que abarcó varios lotes). Si no hay
--   lotes con saldo, queda NULL como hoy — cero regresiones.
--
--   · MISMA FIRMA que v2 (18 y 22 params) → sin cambios en la app, los GRANT
--     existentes se conservan (CREATE OR REPLACE no toca privilegios).
--   · Idempotente: se puede re-ejecutar sin riesgo.
--   · Corre bajo el advisory lock que ya toma cada RPC → sin carreras.
--
-- EJECUCIÓN: Supabase Dashboard → SQL Editor → pegar y RUN.
-- Verificación al final del archivo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A) registrar_movimiento_kardex v3 (18 params, auto-lote FEFO) ──────────

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
  v_lote_final TEXT;
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

  -- ═══ v4 · AUTO-LOTE FEFO para salidas normales sin lote ═══
  -- Si la salida llega sin lote físico, asignarle uno con saldo por lote
  -- suficiente: evita que el bucket lote='' acumule déficit artificial.
  v_lote_final := NULLIF(TRIM(p_lote), '');
  IF p_tipo = 'salida' AND p_codigo_inc IS NULL AND v_lote_final IS NULL THEN
    -- 1) lote cuyo saldo por lote cubre TODA la cantidad (FEFO: vencimiento
    --    más próximo primero; empate: ingreso más antiguo)
    SELECT c.lote INTO v_lote_final
    FROM (
      SELECT m.lote AS lote,
             SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad ELSE -m.cantidad END) AS saldo_lote,
             MIN(m.f_vencimiento) AS min_venc,
             MIN(m.f_modificacion) AS primer_ing
      FROM movimientos m
      WHERE m.bloque = p_bloque
        AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
        AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
        AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
        AND m.codigo = v_codigo_clean
        AND m.codigo_inc IS NULL
        AND NULLIF(TRIM(m.lote), '') IS NOT NULL
      GROUP BY m.lote
    ) c
    WHERE c.saldo_lote >= p_cantidad
    ORDER BY c.min_venc ASC NULLS LAST, c.primer_ing ASC
    LIMIT 1;
    -- 2) si ninguno cubre sola, el de mayor saldo (salida que abarcó varios lotes)
    IF v_lote_final IS NULL THEN
      SELECT c.lote INTO v_lote_final
      FROM (
        SELECT m.lote AS lote,
               SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad ELSE -m.cantidad END) AS saldo_lote
        FROM movimientos m
        WHERE m.bloque = p_bloque
          AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
          AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
          AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
          AND m.codigo = v_codigo_clean
          AND m.codigo_inc IS NULL
          AND NULLIF(TRIM(m.lote), '') IS NOT NULL
        GROUP BY m.lote
      ) c
      WHERE c.saldo_lote > 0
      ORDER BY c.saldo_lote DESC
      LIMIT 1;
    END IF;
  END IF;

  -- Insertar el movimiento (lote = digitado o auto-asignado por FEFO; NULL si no hay)
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, uuid_sync, codigo_inc, lote)
  VALUES (
    p_tipo, p_bloque, p_torre, p_piso, p_posicion, v_codigo_clean,
    p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_uuid_sync, p_codigo_inc,
    v_lote_final
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

-- ── B) registrar_traslado_kardex v3 (22 params, auto-lote FEFO en origen) ──
-- La fila de SALIDA en origen recibe el auto-lote; la de DESTINO lo hereda
-- (el material físico que llega es el del lote que salió).

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
  v_lote_final TEXT;
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

  -- ═══ v4 · AUTO-LOTE FEFO para el traslado (salida en origen) ═══
  v_lote_final := NULLIF(TRIM(p_lote), '');
  IF p_codigo_inc IS NULL AND v_lote_final IS NULL THEN
    SELECT c.lote INTO v_lote_final
    FROM (
      SELECT m.lote AS lote,
             SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad ELSE -m.cantidad END) AS saldo_lote,
             MIN(m.f_vencimiento) AS min_venc,
             MIN(m.f_modificacion) AS primer_ing
      FROM movimientos m
      WHERE m.bloque = p_orig_bloque
        AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
        AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
        AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
        AND m.codigo = v_codigo_clean
        AND m.codigo_inc IS NULL
        AND NULLIF(TRIM(m.lote), '') IS NOT NULL
      GROUP BY m.lote
    ) c
    WHERE c.saldo_lote >= p_cantidad
    ORDER BY c.min_venc ASC NULLS LAST, c.primer_ing ASC
    LIMIT 1;
    IF v_lote_final IS NULL THEN
      SELECT c.lote INTO v_lote_final
      FROM (
        SELECT m.lote AS lote,
               SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad ELSE -m.cantidad END) AS saldo_lote
        FROM movimientos m
        WHERE m.bloque = p_orig_bloque
          AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
          AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
          AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
          AND m.codigo = v_codigo_clean
          AND m.codigo_inc IS NULL
          AND NULLIF(TRIM(m.lote), '') IS NOT NULL
        GROUP BY m.lote
      ) c
      WHERE c.saldo_lote > 0
      ORDER BY c.saldo_lote DESC
      LIMIT 1;
    END IF;
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
    v_lote_final
  );

  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync, lote)
  VALUES (
    'traslado', p_dest_bloque, p_dest_torre, p_dest_piso, p_dest_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc,
    NULL,
    v_lote_final
  );

  RETURN jsonb_build_object(
    'success', true,
    'origin_previous_stock', v_orig_stock,
    'origin_new_stock', v_orig_stock - p_cantidad + COALESCE(p_cantidad_ajuste, 0)
  );
END;
$$;

-- ── C) Verificación de firmas y permisos ───────────────────────────────────
-- Los GRANT de la migración anterior (18 y 22 params) se conservan porque la
-- firma no cambió. Chequeo rápido:
DO $$
DECLARE
  v_ok INT;
BEGIN
  SELECT COUNT(*) INTO v_ok FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('registrar_movimiento_kardex','registrar_traslado_kardex');
  RAISE NOTICE 'RPCs presentes: %', v_ok;
END $$;
