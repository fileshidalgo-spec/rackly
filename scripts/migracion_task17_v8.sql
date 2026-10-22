-- ═══ Task 17 · Migración v8 — auditoría profunda de movimientos ═══
-- 1) FECHA_INVALIDA si el vencimiento tiene año fuera de 2000–2100 en TODOS
--    los RPCs de movimiento (typos reales: 0202/3027/20828 corrompen FEFO).
--    En Tránsito la fecha heredada de Recepción se normaliza a NULL (no
--    bloquea la transferencia; regla v2 permite sin fecha).
-- 2) rq_atender_item / rq_revertir_item: UPDATE atómico (anti update-perdido
--    en doble tap) + guard de rol + REVOKE EXECUTE FROM PUBLIC.
-- Generado a partir de las definiciones REALES de producción (dump pg_get_functiondef).

CREATE OR REPLACE FUNCTION public.registrar_movimiento_kardex(p_tipo text, p_bloque text, p_torre text, p_piso text, p_posicion text, p_codigo text, p_descripcion text, p_un text, p_cantidad numeric, p_f_vencimiento date, p_turno text, p_usuario_id uuid, p_usuario_nombre text, p_usuario_correo text, p_proveedor text, p_uuid_sync text DEFAULT NULL::text, p_codigo_inc text DEFAULT NULL::text, p_lote text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_stock NUMERIC;
  v_loc_key TEXT;
  v_codigo_clean TEXT;
  v_lote_final TEXT;
  v_saldo_sin_lote NUMERIC;
  v_saldo_lote_digit NUMERIC;
BEGIN
  -- Normalizar codigo
  v_codigo_clean := UPPER(TRIM(p_codigo));

  -- v7 (auditoría 2026-10-21): la cantidad debe ser positiva. Antes una
  -- salida con cantidad negativa pasaba la validación de stock y SUMABA,
  -- y un ingreso negativo RESTABA — corrupción silenciosa del inventario.
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad debe ser mayor que cero';
  END IF;

  -- v8 (auditoría 2026-10-23): rechazar vencimientos con año absurdo.
  -- Typos reales en producción: 0202, 3027, 20828 — corrompen el FEFO
  -- (0202 "vence" siempre primero; 3027 nunca). Rango operativo: 2000–2100.
  IF p_f_vencimiento IS NOT NULL AND
     (EXTRACT(YEAR FROM p_f_vencimiento) < 2000
      OR EXTRACT(YEAR FROM p_f_vencimiento) > 2100) THEN
    RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', p_f_vencimiento;
  END IF;

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

  -- ═══ v6 · VALIDACIÓN del lote digitado en salidas normales ═══
  IF p_tipo = 'salida' AND p_codigo_inc IS NULL AND v_lote_final IS NOT NULL THEN
    SELECT COALESCE(SUM(
      CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad
           WHEN m.tipo = 'salida' THEN -m.cantidad ELSE 0 END), 0)
      INTO v_saldo_lote_digit
    FROM movimientos m
    WHERE m.bloque = p_bloque
      AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
      AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
      AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
      AND m.codigo = v_codigo_clean
      AND m.codigo_inc IS NULL
      AND NULLIF(TRIM(m.lote), '') = v_lote_final;
    IF COALESCE(v_saldo_lote_digit, 0) < p_cantidad THEN
      v_lote_final := NULL;  -- sin cobertura: decide el pipeline v4/v5
    END IF;
  END IF;
  IF p_tipo = 'salida' AND p_codigo_inc IS NULL AND v_lote_final IS NULL THEN
    -- 1) lote cuyo saldo por lote cubre TODA la cantidad (FEFO)
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
    -- 2) v5 · bucket "sin lote" absorbe la salida si tiene saldo suficiente
    IF v_lote_final IS NULL THEN
      SELECT COALESCE(SUM(
        CASE WHEN m2.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m2.cantidad
             WHEN m2.tipo = 'salida' THEN -m2.cantidad ELSE 0 END), 0)
        INTO v_saldo_sin_lote
      FROM movimientos m2
      WHERE m2.bloque = p_bloque
        AND TRIM(LEADING '0' FROM m2.torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
        AND TRIM(LEADING '0' FROM m2.piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
        AND TRIM(LEADING '0' FROM m2.posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
        AND m2.codigo = v_codigo_clean
        AND m2.codigo_inc IS NULL
        AND COALESCE(TRIM(m2.lote), '') = '';
    END IF;
    -- 3) último recurso: el lote físico de mayor saldo
    IF v_lote_final IS NULL AND COALESCE(v_saldo_sin_lote, 0) < p_cantidad THEN
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
$function$

CREATE OR REPLACE FUNCTION public.registrar_traslado_kardex(p_codigo text, p_descripcion text, p_un text, p_cantidad numeric, p_orig_bloque text, p_orig_torre text, p_orig_piso text, p_orig_pos text, p_dest_bloque text, p_dest_torre text, p_dest_piso text, p_dest_pos text, p_turno text, p_usuario_id uuid, p_usuario_nombre text, p_usuario_correo text, p_f_vencimiento date, p_proveedor text, p_cantidad_ajuste numeric DEFAULT 0, p_codigo_inc text DEFAULT NULL::text, p_uuid_sync text DEFAULT NULL::text, p_lote text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_orig_stock NUMERIC;
  v_codigo_clean TEXT;
  v_orig_key TEXT;
  v_dest_key TEXT;
  v_lote_final TEXT;
  v_saldo_sin_lote NUMERIC;
BEGIN
  v_codigo_clean := UPPER(TRIM(p_codigo));

  -- v7 (auditoría 2026-10-21): la cantidad debe ser positiva
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad a trasladar debe ser mayor que cero';
  END IF;

  -- v8 (auditoría 2026-10-23): rechazar vencimientos con año absurdo.
  -- Typos reales en producción: 0202, 3027, 20828 — corrompen el FEFO
  -- (0202 "vence" siempre primero; 3027 nunca). Rango operativo: 2000–2100.
  IF p_f_vencimiento IS NOT NULL AND
     (EXTRACT(YEAR FROM p_f_vencimiento) < 2000
      OR EXTRACT(YEAR FROM p_f_vencimiento) > 2100) THEN
    RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', p_f_vencimiento;
  END IF;

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

  -- v7 (auditoría 2026-10-21): el AJUSTE POSITIVO ingresa mercadería en origen
  -- ANTES de la salida (misma transacción, fila 'ingreso' más abajo), así que
  -- el disponible real es stock + ajuste. Antes se validaba solo contra el
  -- stock y el ajuste positivo era inalcanzable desde la UI (feature muerta).
  IF p_cantidad > v_orig_stock + COALESCE(p_cantidad_ajuste, 0) THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK_ORIGIN|Stock en origen = % %, cantidad a trasladar = % (ajuste = %)',
      v_orig_stock, COALESCE(p_un, ''), p_cantidad, COALESCE(p_cantidad_ajuste, 0);
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
    -- 2) v5 · bucket "sin lote" del origen absorbe si tiene saldo suficiente
    IF v_lote_final IS NULL THEN
      SELECT COALESCE(SUM(
        CASE WHEN m2.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m2.cantidad
             WHEN m2.tipo = 'salida' THEN -m2.cantidad ELSE 0 END), 0)
        INTO v_saldo_sin_lote
      FROM movimientos m2
      WHERE m2.bloque = p_orig_bloque
        AND TRIM(LEADING '0' FROM m2.torre) = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
        AND TRIM(LEADING '0' FROM m2.piso) = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
        AND TRIM(LEADING '0' FROM m2.posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
        AND m2.codigo = v_codigo_clean
        AND m2.codigo_inc IS NULL
        AND COALESCE(TRIM(m2.lote), '') = '';
    END IF;
    -- 3) último recurso: el lote físico de mayor saldo
    IF v_lote_final IS NULL AND COALESCE(v_saldo_sin_lote, 0) < p_cantidad THEN
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
  -- Solo la PRIMERA fila del traslado lleva uuid_sync (idempotencia)
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
$function$

CREATE OR REPLACE FUNCTION public.editar_lote_vencimiento_racks(p_bloque text, p_torre text, p_piso text, p_posicion text, p_codigo text, p_lote text DEFAULT NULL::text, p_f_vencimiento text DEFAULT NULL::text, p_lote_actual text DEFAULT NULL::text, p_f_vencimiento_actual text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_codigo      TEXT;
  v_lote        TEXT;
  v_fven        DATE;
  v_lote_actual TEXT;
  v_fven_actual DATE;
  v_rows        INT;
  v_loc_key     TEXT;
BEGIN
  v_codigo := UPPER(TRIM(p_codigo));
  v_lote   := NULLIF(TRIM(p_lote), '');
  v_lote_actual := NULLIF(TRIM(p_lote_actual), '');

  -- Fechas con mensaje claro si el formato no es AAAA-MM-DD
  IF p_f_vencimiento IS NOT NULL AND TRIM(p_f_vencimiento) <> '' THEN
    BEGIN
      v_fven := TRIM(p_f_vencimiento)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;
  IF p_f_vencimiento_actual IS NOT NULL AND TRIM(p_f_vencimiento_actual) <> '' THEN
    BEGIN
      v_fven_actual := TRIM(p_f_vencimiento_actual)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento actual inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;

  -- v8 (auditoría 2026-10-23): el NUEVO valor no puede tener año absurdo
  -- (0202/3027/…). El valor ACTUAL (v_fven_actual) NO se valida: existen filas
  -- históricas con año absurdo y deben poder corregirse.
  IF v_fven IS NOT NULL AND
     (EXTRACT(YEAR FROM v_fven) < 2000 OR EXTRACT(YEAR FROM v_fven) > 2100) THEN
    RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fven;
  END IF;

  IF v_codigo IS NULL OR v_codigo = '' THEN
    RAISE EXCEPTION 'SIN_DATOS|Código de artículo vacío';
  END IF;
  IF v_lote IS NULL AND v_fven IS NULL THEN
    RAISE EXCEPTION 'SIN_DATOS|Indique el lote y/o la fecha de vencimiento del producto';
  END IF;

  -- Anti-carrera: misma llave que registrar_movimiento_kardex (bloque/torre/
  -- piso/posicion/código) para que ninguna salida se intercale durante el cambio.
  v_loc_key := p_bloque || '/' || p_torre || '/' || p_piso || '/' || p_posicion || '/' || v_codigo;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_loc_key, 0));

  UPDATE movimientos
  SET lote = v_lote,
      f_vencimiento = v_fven
  WHERE bloque = p_bloque
    AND TRIM(LEADING '0' FROM torre)    = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
    AND TRIM(LEADING '0' FROM piso)     = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
    AND TRIM(LEADING '0' FROM posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
    AND codigo = v_codigo
    AND codigo_inc IS NULL
    -- Bucket EXACTO a editar (v1 = bucket vacío; v2 = cualquier bucket mostrado)
    AND COALESCE(TRIM(lote), '') = COALESCE(v_lote_actual, '')
    AND f_vencimiento IS NOT DISTINCT FROM v_fven_actual;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'SIN_FILAS|No hay stock con esos datos para % en esa ubicación (puede que ya se haya corregido)', v_codigo;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'filas_actualizadas', v_rows,
    'lote', v_lote,
    'f_vencimiento', v_fven
  );
END;
$function$

CREATE OR REPLACE FUNCTION public.piso_registrar_movimiento(_tipo text, _turno text, _detalles jsonb DEFAULT '[]'::jsonb, _uuid_sync text DEFAULT NULL::text, _codigo_inc text DEFAULT NULL::text, _usuario_id text DEFAULT NULL::text, _usuario_nombre text DEFAULT NULL::text, _usuario_correo text DEFAULT NULL::text, _posicion_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mov_id   uuid;
  v_num_out  bigint;
  v_detalle  jsonb;
  v_nivel_id uuid;
  v_txt      text;
  v_fecha    date;
  v_cantidad numeric;
BEGIN
  IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar movimientos';
  END IF;

  IF _tipo NOT IN ('ingreso', 'devolucion', 'stock_inicial') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO|piso_registrar_movimiento solo acepta ingreso/devolucion/stock_inicial (las salidas van por piso_salida_posicion)';
  END IF;

  -- Idempotencia
  IF _uuid_sync IS NOT NULL AND _uuid_sync <> '' THEN
    SELECT id INTO v_mov_id FROM piso_movimientos WHERE uuid_sync = _uuid_sync LIMIT 1;
    IF v_mov_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'id', v_mov_id, 'idempotent', true);
    END IF;
  END IF;

  -- Locks por nivel (orden determinista)
  IF _detalles IS NOT NULL AND jsonb_array_length(_detalles) > 0 THEN
    FOR v_nivel_id IN
      SELECT DISTINCT (d->>'nivel_id')::uuid
      FROM jsonb_array_elements(_detalles) AS d
      ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_nivel_id::text, 0));
    END LOOP;
  END IF;

  -- Cabecera (numero_operacion por SECUENCIA; codigo_inc y posicion_id opcionales)
  INSERT INTO piso_movimientos (tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, codigo_inc, posicion_id)
  VALUES (_tipo, now(), _turno, NULLIF(btrim(_usuario_id), '')::uuid, _usuario_nombre, _usuario_correo, _uuid_sync, NULLIF(_codigo_inc, ''), _posicion_id)
  RETURNING id, numero_operacion INTO v_mov_id, v_num_out;

  -- Detalles (lote + fecha tolerante)
  IF _detalles IS NOT NULL AND jsonb_array_length(_detalles) > 0 THEN
    FOR v_detalle IN SELECT * FROM jsonb_array_elements(_detalles)
    LOOP
      -- v7 (auditoría 2026-10-21): rechazar detalles con cantidad <= 0.
      -- Antes se insertaban con COALESCE(..., 0): filas "fantasma" con 0.
      v_cantidad := COALESCE((v_detalle->>'cantidad')::numeric, 0);
      IF v_cantidad <= 0 THEN
        RAISE EXCEPTION 'CANTIDAD_INVALIDA|Cada detalle debe tener cantidad mayor que cero';
      END IF;

      v_txt   := v_detalle->>'fecha_vencimiento';
      v_fecha := NULL;
      IF v_txt IS NOT NULL AND v_txt <> '' AND v_txt <> 'null' THEN
        BEGIN
          v_fecha := to_date(v_txt, 'YYYY-MM-DD');
        EXCEPTION WHEN OTHERS THEN
          BEGIN
            v_fecha := v_txt::timestamptz::date;
          EXCEPTION WHEN OTHERS THEN
            v_fecha := NULL;
          END;
        END;
      END IF;

      -- v8 (auditoría 2026-10-23): año absurdo corrompe el FEFO (2000–2100).
      IF v_fecha IS NOT NULL AND
         (EXTRACT(YEAR FROM v_fecha) < 2000 OR EXTRACT(YEAR FROM v_fecha) > 2100) THEN
        RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fecha;
      END IF;

      INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
      VALUES (
        v_mov_id,
        (v_detalle->>'nivel_id')::uuid,
        (v_detalle->>'bloque_id')::uuid,
        v_cantidad,
        v_fecha,
        NULLIF(btrim(COALESCE(v_detalle->>'lote', '')), '')
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_mov_id, 'numero_operacion', v_num_out);
END;
$function$

CREATE OR REPLACE FUNCTION public.piso_traslado_posicion(p_turno text, p_usuario_id text, p_usuario_nombre text, p_usuario_correo text, p_uuid_sync text DEFAULT NULL::text, p_detalles_salida jsonb DEFAULT '[]'::jsonb, p_detalles_ingreso jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sal_id          uuid;
  v_ing_id          uuid;
  v_num_sal         bigint;
  v_num_ing         bigint;
  v_detalle         jsonb;
  v_nivel_id        uuid;
  v_bloque_id       uuid;
  v_cant_solicitada numeric;
  v_stock_actual    numeric;
  v_bloque_codigo   text;
  v_total_sal       numeric;
  v_total_ing       numeric;
  v_existentes      int;
  v_txt             text;
  v_fecha           date;
BEGIN
  IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar traslados';
  END IF;

  IF p_detalles_salida IS NULL OR jsonb_array_length(p_detalles_salida) = 0
     OR p_detalles_ingreso IS NULL OR jsonb_array_length(p_detalles_ingreso) = 0 THEN
    RAISE EXCEPTION 'DETALLES_VACIOS|El traslado requiere artículos de salida y de ingreso';
  END IF;

  -- Idempotencia: 2 cabeceras con el mismo uuid_sync → ya registrado.
  -- 1 sola cabecera = traslado PARCIAL de un intento previo: se limpia y se
  -- rehace completo aquí (antes el reintento creaba un TERCER movimiento).
  IF p_uuid_sync IS NOT NULL AND p_uuid_sync <> '' THEN
    SELECT count(*) INTO v_existentes FROM piso_movimientos WHERE uuid_sync = p_uuid_sync;
    IF v_existentes >= 2 THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true);
    END IF;
    IF v_existentes = 1 THEN
      DELETE FROM piso_movimiento_detalles
       WHERE movimiento_id IN (SELECT id FROM piso_movimientos WHERE uuid_sync = p_uuid_sync);
      DELETE FROM piso_movimientos WHERE uuid_sync = p_uuid_sync;
    END IF;
  END IF;

  -- Verificación de saldos: salida total = ingreso total
  SELECT COALESCE(SUM((e->>'cantidad')::numeric), 0) INTO v_total_sal
    FROM jsonb_array_elements(p_detalles_salida) AS e;
  SELECT COALESCE(SUM((e->>'cantidad')::numeric), 0) INTO v_total_ing
    FROM jsonb_array_elements(p_detalles_ingreso) AS e;
  IF round(v_total_sal, 3) <> round(v_total_ing, 3) THEN
    RAISE EXCEPTION 'MISMATCH_QUANTITY|La cantidad total de salida (%) no coincide con la de ingreso (%)',
      round(v_total_sal, 3), round(v_total_ing, 3);
  END IF;

  -- Locks por nivel de AMBAS listas (origen y destino), orden determinista
  FOR v_nivel_id IN
    SELECT DISTINCT nid FROM (
      SELECT (d->>'nivel_id')::uuid AS nid FROM jsonb_array_elements(p_detalles_salida) AS d
      UNION
      SELECT (d->>'nivel_id')::uuid AS nid FROM jsonb_array_elements(p_detalles_ingreso) AS d
    ) sub
    ORDER BY nid
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_nivel_id::text, 0));
  END LOOP;

  -- Validación de stock del ORIGEN (misma aritmética que la app)
  FOR v_nivel_id, v_bloque_id, v_cant_solicitada IN
    SELECT (d->>'nivel_id')::uuid,
           (d->>'bloque_id')::uuid,
           COALESCE(SUM((d->>'cantidad')::numeric), 0)
    FROM jsonb_array_elements(p_detalles_salida) AS d
    GROUP BY 1, 2
  LOOP
    IF v_cant_solicitada <= 0 THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA|Todas las cantidades deben ser mayores a 0';
    END IF;

    SELECT COALESCE(SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','stock_inicial') THEN md.cantidad ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN m.tipo = 'salida' THEN md.cantidad ELSE 0 END), 0)
      INTO v_stock_actual
      FROM piso_movimiento_detalles md
      JOIN piso_movimientos m ON m.id = md.movimiento_id
     WHERE md.nivel_id = v_nivel_id
       AND md.bloque_id = v_bloque_id;

    SELECT codigo INTO v_bloque_codigo FROM piso_bloques WHERE id = v_bloque_id;

    IF round(v_cant_solicitada, 3) > round(COALESCE(v_stock_actual, 0), 3) + 1e-9 THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK|Traslado: stock insuficiente para % en origen: solicita %, disponible %',
        COALESCE(v_bloque_codigo, 'bloque'),
        round(v_cant_solicitada, 3),
        round(COALESCE(v_stock_actual, 0), 3);
    END IF;
  END LOOP;

  -- Cabeceras salida + ingreso (numero_operacion por SECUENCIA en ambas)
  INSERT INTO piso_movimientos (tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('salida', now(), p_turno, NULLIF(btrim(p_usuario_id), '')::uuid, p_usuario_nombre, p_usuario_correo, p_uuid_sync)
  RETURNING id, numero_operacion INTO v_sal_id, v_num_sal;

  INSERT INTO piso_movimientos (tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('ingreso', now(), p_turno, NULLIF(btrim(p_usuario_id), '')::uuid, p_usuario_nombre, p_usuario_correo, p_uuid_sync)
  RETURNING id, numero_operacion INTO v_ing_id, v_num_ing;

  -- Detalles de SALIDA (con lote y fecha tolerante)
  FOR v_detalle IN SELECT * FROM jsonb_array_elements(p_detalles_salida)
  LOOP
    v_txt   := v_detalle->>'fecha_vencimiento';
    v_fecha := NULL;
    IF v_txt IS NOT NULL AND v_txt <> '' AND v_txt <> 'null' THEN
      BEGIN
        v_fecha := to_date(v_txt, 'YYYY-MM-DD');
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          v_fecha := v_txt::timestamptz::date;
        EXCEPTION WHEN OTHERS THEN
          v_fecha := NULL;
        END;
      END;
    END IF;

      -- v8 (auditoría 2026-10-23): año absurdo corrompe el FEFO (2000–2100).
      IF v_fecha IS NOT NULL AND
         (EXTRACT(YEAR FROM v_fecha) < 2000 OR EXTRACT(YEAR FROM v_fecha) > 2100) THEN
        RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fecha;
      END IF;

    INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    VALUES (v_sal_id,
            (v_detalle->>'nivel_id')::uuid,
            (v_detalle->>'bloque_id')::uuid,
            COALESCE((v_detalle->>'cantidad')::numeric, 0),
            v_fecha,
            NULLIF(btrim(COALESCE(v_detalle->>'lote', '')), ''));
  END LOOP;

  -- Detalles de INGRESO (destino; el lote viaja con la mercadería)
  FOR v_detalle IN SELECT * FROM jsonb_array_elements(p_detalles_ingreso)
  LOOP
    v_txt   := v_detalle->>'fecha_vencimiento';
    v_fecha := NULL;
    IF v_txt IS NOT NULL AND v_txt <> '' AND v_txt <> 'null' THEN
      BEGIN
        v_fecha := to_date(v_txt, 'YYYY-MM-DD');
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          v_fecha := v_txt::timestamptz::date;
        EXCEPTION WHEN OTHERS THEN
          v_fecha := NULL;
        END;
      END;
    END IF;

      -- v8 (auditoría 2026-10-23): año absurdo corrompe el FEFO (2000–2100).
      IF v_fecha IS NOT NULL AND
         (EXTRACT(YEAR FROM v_fecha) < 2000 OR EXTRACT(YEAR FROM v_fecha) > 2100) THEN
        RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fecha;
      END IF;

    INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    VALUES (v_ing_id,
            (v_detalle->>'nivel_id')::uuid,
            (v_detalle->>'bloque_id')::uuid,
            COALESCE((v_detalle->>'cantidad')::numeric, 0),
            v_fecha,
            NULLIF(btrim(COALESCE(v_detalle->>'lote', '')), ''));
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'salida_id', v_sal_id,
    'ingreso_id', v_ing_id,
    'numero_salida', v_num_sal,
    'numero_ingreso', v_num_ing
  );
END;
$function$

CREATE OR REPLACE FUNCTION public.piso_salida_posicion(p_turno text, p_usuario_id text, p_usuario_nombre text, p_usuario_correo text, p_uuid_sync text DEFAULT NULL::text, p_detalles jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mov_id          uuid;
  v_num_out         bigint;
  v_detalle         jsonb;
  v_nivel_id        uuid;
  v_bloque_id       uuid;
  v_cant_solicitada numeric;
  v_stock_actual    numeric;
  v_bloque_codigo   text;
  v_txt             text;
  v_fecha           date;
BEGIN
  -- Guard (defensa en profundidad; RLS ya bloquea a anon)
  IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar salidas';
  END IF;

  IF p_detalles IS NULL OR jsonb_array_length(p_detalles) = 0 THEN
    RAISE EXCEPTION 'DETALLES_VACIOS|La salida no tiene artículos';
  END IF;

  -- Idempotencia: mismo uuid_sync → ya registrado
  IF p_uuid_sync IS NOT NULL AND p_uuid_sync <> '' THEN
    SELECT id INTO v_mov_id FROM piso_movimientos WHERE uuid_sync = p_uuid_sync LIMIT 1;
    IF v_mov_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'id', v_mov_id, 'idempotent', true);
    END IF;
  END IF;

  -- Locks por nivel (bloqueantes; orden determinista evita deadlocks entre
  -- traslados concurrentes). Ya no try_lock global: bajo concurrencia se
  -- ENCOLA en vez de fallar con "Otra operación está en curso".
  FOR v_nivel_id IN
    SELECT DISTINCT (d->>'nivel_id')::uuid
    FROM jsonb_array_elements(p_detalles) AS d
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_nivel_id::text, 0));
  END LOOP;

  -- Validación de stock contra la BD real (misma aritmética que la app,
  -- tolerancia de redondeo a 3 decimales). Dentro de los locks: sin TOCTOU.
  FOR v_nivel_id, v_bloque_id, v_cant_solicitada IN
    SELECT (d->>'nivel_id')::uuid,
           (d->>'bloque_id')::uuid,
           COALESCE(SUM((d->>'cantidad')::numeric), 0)
    FROM jsonb_array_elements(p_detalles) AS d
    GROUP BY 1, 2
  LOOP
    IF v_cant_solicitada <= 0 THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA|Todas las cantidades deben ser mayores a 0';
    END IF;

    SELECT COALESCE(SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','stock_inicial') THEN md.cantidad ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN m.tipo = 'salida' THEN md.cantidad ELSE 0 END), 0)
      INTO v_stock_actual
      FROM piso_movimiento_detalles md
      JOIN piso_movimientos m ON m.id = md.movimiento_id
     WHERE md.nivel_id = v_nivel_id
       AND md.bloque_id = v_bloque_id;

    SELECT codigo INTO v_bloque_codigo FROM piso_bloques WHERE id = v_bloque_id;

    IF round(v_cant_solicitada, 3) > round(COALESCE(v_stock_actual, 0), 3) + 1e-9 THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK|Stock insuficiente para %: solicita %, disponible %',
        COALESCE(v_bloque_codigo, 'bloque'),
        round(v_cant_solicitada, 3),
        round(COALESCE(v_stock_actual, 0), 3);
    END IF;
  END LOOP;

  -- Cabecera: numero_operacion lo asigna la SECUENCIA (columna default);
  -- se elimina el MAX+1 que competía con la secuencia del cliente.
  INSERT INTO piso_movimientos (tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('salida', now(), p_turno, NULLIF(btrim(p_usuario_id), '')::uuid, p_usuario_nombre, p_usuario_correo, p_uuid_sync)
  RETURNING id, numero_operacion INTO v_mov_id, v_num_out;

  -- Detalles: con lote físico y parseo de fecha tolerante (ISO o timestamp)
  FOR v_detalle IN SELECT * FROM jsonb_array_elements(p_detalles)
  LOOP
    v_txt   := v_detalle->>'fecha_vencimiento';
    v_fecha := NULL;
    IF v_txt IS NOT NULL AND v_txt <> '' AND v_txt <> 'null' THEN
      BEGIN
        v_fecha := to_date(v_txt, 'YYYY-MM-DD');
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          v_fecha := v_txt::timestamptz::date;
        EXCEPTION WHEN OTHERS THEN
          v_fecha := NULL;
        END;
      END;
    END IF;

      -- v8 (auditoría 2026-10-23): año absurdo corrompe el FEFO (2000–2100).
      IF v_fecha IS NOT NULL AND
         (EXTRACT(YEAR FROM v_fecha) < 2000 OR EXTRACT(YEAR FROM v_fecha) > 2100) THEN
        RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fecha;
      END IF;

    INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    VALUES (
      v_mov_id,
      (v_detalle->>'nivel_id')::uuid,
      (v_detalle->>'bloque_id')::uuid,
      COALESCE((v_detalle->>'cantidad')::numeric, 0),
      v_fecha,
      NULLIF(btrim(COALESCE(v_detalle->>'lote', '')), '')
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'id', v_mov_id, 'numero_operacion', v_num_out);
END;
$function$

CREATE OR REPLACE FUNCTION public.piso_registrar_salida(_turno text, _usuario_id uuid, _usuario_nombre text, _usuario_correo text, _uuid_sync text DEFAULT NULL::text, _detalles jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE
  v_mov_id   UUID;
  v_det      JSONB;
  v_nivel_id UUID;
  v_bloque_id UUID;
  v_qty      NUMERIC;
  v_current  NUMERIC;
  v_fecha    DATE;
BEGIN
  FOR v_nivel_id IN
    SELECT DISTINCT (d->>'nivel_id')::UUID
    FROM jsonb_array_elements(_detalles) AS d
    ORDER BY (d->>'nivel_id')::TEXT
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_nivel_id::TEXT, 0));
  END LOOP;

  FOR v_nivel_id, v_bloque_id, v_qty IN
    SELECT
      (d->>'nivel_id')::UUID,
      (d->>'bloque_id')::UUID,
      COALESCE(SUM((d->>'cantidad')::NUMERIC), 0)
    FROM jsonb_array_elements(_detalles) AS d
    GROUP BY (d->>'nivel_id')::UUID, (d->>'bloque_id')::UUID
  LOOP
    SELECT COALESCE(SUM(
      CASE
        WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion') THEN dd.cantidad
        WHEN m.tipo = 'salida' THEN -dd.cantidad
        ELSE 0
      END
    ), 0) INTO v_current
    FROM public.piso_movimiento_detalles dd
    JOIN public.piso_movimientos m ON m.id = dd.movimiento_id
    WHERE dd.nivel_id = v_nivel_id
      AND dd.bloque_id = v_bloque_id
      AND m.codigo_inc IS NULL;

    IF v_qty > v_current THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK|Stock actual = %, cantidad solicitada = %',
        v_current, v_qty;
    END IF;
  END LOOP;

  INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('salida', _turno, _usuario_id, _usuario_nombre, _usuario_correo, _uuid_sync)
  RETURNING id INTO v_mov_id;

  FOR v_det IN SELECT * FROM jsonb_array_elements(_detalles)
  LOOP
    BEGIN
      v_fecha := NULL;
      IF v_det->>'fecha_vencimiento' IS NOT NULL
         AND (v_det->>'fecha_vencimiento') != ''
         AND (v_det->>'fecha_vencimiento') != 'null' THEN
        v_fecha := to_date(v_det->>'fecha_vencimiento', 'YYYY-MM-DD');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        v_fecha := (v_det->>'fecha_vencimiento')::TIMESTAMPTZ::DATE;
      EXCEPTION WHEN OTHERS THEN
        v_fecha := NULL;
      END;
    END;

    -- v8 (auditoría 2026-10-23): año absurdo corrompe el FEFO (2000–2100).
    IF v_fecha IS NOT NULL AND
       (EXTRACT(YEAR FROM v_fecha) < 2000 OR EXTRACT(YEAR FROM v_fecha) > 2100) THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fecha;
    END IF;

    INSERT INTO public.piso_movimiento_detalles (
      movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento
    ) VALUES (
      v_mov_id,
      (v_det->>'nivel_id')::UUID,
      (v_det->>'bloque_id')::UUID,
      COALESCE((v_det->>'cantidad')::NUMERIC, 0),
      v_fecha
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'movimiento_id', v_mov_id);
END;
 $function$

CREATE OR REPLACE FUNCTION public.editar_lote_vencimiento_piso(p_posicion_id uuid, p_bloque_id uuid, p_lote text DEFAULT NULL::text, p_f_vencimiento text DEFAULT NULL::text, p_lote_actual text DEFAULT NULL::text, p_f_vencimiento_actual text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lote        TEXT;
  v_fven        DATE;
  v_lote_actual TEXT;
  v_fven_actual DATE;
  v_rows        INT;
  v_lock        TEXT;
BEGIN
  v_lote        := NULLIF(TRIM(p_lote), '');
  v_lote_actual := NULLIF(TRIM(p_lote_actual), '');

  IF p_f_vencimiento IS NOT NULL AND TRIM(p_f_vencimiento) <> '' THEN
    BEGIN
      v_fven := TRIM(p_f_vencimiento)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;
  IF p_f_vencimiento_actual IS NOT NULL AND TRIM(p_f_vencimiento_actual) <> '' THEN
    BEGIN
      v_fven_actual := TRIM(p_f_vencimiento_actual)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento actual inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;

  IF v_lote IS NULL AND v_fven IS NULL THEN
    RAISE EXCEPTION 'SIN_DATOS|Indique el lote y/o la fecha de vencimiento del producto';
  END IF;

  -- v8 (auditoría 2026-10-23): el NUEVO valor no puede tener año absurdo
  -- (0202/3027/…). El valor ACTUAL (v_fven_actual) NO se valida: existen filas
  -- históricas con año absurdo y deben poder corregirse.
  IF v_fven IS NOT NULL AND
     (EXTRACT(YEAR FROM v_fven) < 2000 OR EXTRACT(YEAR FROM v_fven) > 2100) THEN
    RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fven;
  END IF;

  -- Anti-carrera por posición+artículo
  v_lock := p_posicion_id::text || '/' || p_bloque_id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lock, 0));

  UPDATE piso_movimiento_detalles d
  SET lote = v_lote,
      fecha_vencimiento = v_fven
  FROM piso_niveles n
  WHERE d.nivel_id = n.id
    AND n.posicion_id = p_posicion_id
    AND d.bloque_id = p_bloque_id
    -- Bucket EXACTO a editar (v1 = bucket vacío; v2 = cualquier bucket mostrado)
    AND COALESCE(TRIM(d.lote), '') = COALESCE(v_lote_actual, '')
    AND d.fecha_vencimiento IS NOT DISTINCT FROM v_fven_actual;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'SIN_FILAS|No hay stock con esos datos para este artículo en esa posición (puede que ya se haya corregido)';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'filas_actualizadas', v_rows,
    'lote', v_lote,
    'f_vencimiento', v_fven
  );
END;
$function$

CREATE OR REPLACE FUNCTION public.transito_registrar_envio(p_recepcion_id uuid, p_tipo_destino text, p_cantidad numeric, p_turno text, p_usuario_id uuid, p_usuario_nombre text, p_usuario_correo text, p_uuid_sync text, p_rack jsonb DEFAULT NULL::jsonb, p_piso jsonb DEFAULT NULL::jsonb, p_ubicacion text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.recepcion_registros%ROWTYPE;
  v_envios jsonb;
  v_enviados numeric;
  v_pendiente numeric;
  v_nuevo jsonb;
  v_lote text;
  v_venc date;
  v_codigo text;
  v_descripcion text;
  v_un text;
  v_prov text;
  v_res jsonb;
  v_mov_id uuid;
  v_bloque_piso_id uuid;
BEGIN
  -- GUARD de autorización: la RPC es SECURITY DEFINER (escribe en movimientos,
  -- piso_movimientos, recepcion_registros). Nunca ejecutable por anon.
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar envíos de Tránsito';
  END IF;

  IF p_tipo_destino NOT IN ('rack', 'piso') THEN
    RAISE EXCEPTION 'DESTINO_INVALIDO|El destino debe ser rack o piso (recibido: %)', p_tipo_destino;
  END IF;
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad a transferir debe ser mayor que cero';
  END IF;
  IF p_uuid_sync IS NULL OR TRIM(p_uuid_sync) = '' THEN
    RAISE EXCEPTION 'UUID_REQUERIDO|Falta el identificador único del envío';
  END IF;

  -- Lock por fila de recepción: dos envíos simultáneos del mismo artículo se
  -- serializan y el anti-sobreenvío siempre ve el total real.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_recepcion_id::text, 7771));

  SELECT * INTO v_row FROM public.recepcion_registros WHERE id = p_recepcion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEPCION_NO_EXISTE|La fila de recepción ya no existe';
  END IF;

  v_envios := COALESCE(v_row.transito -> 'envios', '[]'::jsonb);

  -- IDEMPOTENCIA: mismo uuid del envío => ya registrado, devolver éxito sin tocar nada
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_envios) AS e
    WHERE e ->> 'uuid' = p_uuid_sync
  ) THEN
    RETURN jsonb_build_object('ok', true, 'duplicado', true, 'recepcion_id', p_recepcion_id);
  END IF;

  -- ANTI-SOBREENVÍO: lo enviado no puede superar la cantidad registrada
  SELECT COALESCE(SUM((e ->> 'cantidad')::numeric), 0) INTO v_enviados
  FROM jsonb_array_elements(v_envios) AS e;
  v_pendiente := v_row.cantidad - v_enviados;
  IF p_cantidad > v_pendiente THEN
    RAISE EXCEPTION 'OVER_ISSUE|La cantidad a transferir (%) excede el pendiente de % (%): excedente %',
      p_cantidad, v_row.codigo, v_pendiente, (p_cantidad - v_pendiente);
  END IF;

  -- Regla TRÁNSITO (v2 2026-10-20): SIN lote o SIN fecha de vencimiento ya NO
  -- bloquea. El proveedor a veces no trae esos datos; se transfieren CON
  -- confirmación explícita en la UI y luego se completan/corrigen con
  -- editar_lote (v1/v2) en Racks/Piso. lote='' se normaliza a NULL abajo.

  v_lote := TRIM(COALESCE(v_row.lote, ''));

  -- v8 (auditoría 2026-10-23): si la fila de Recepción trae un vencimiento con
  -- año absurdo (typo histórico: 0202/3027/…), NO se propaga a Racks/Piso:
  -- viaja como sin fecha (la regla v2 ya permite transferir sin fecha con
  -- confirmación) y el flujo de tránsito NO se bloquea. La fila original se
  -- corrige en Recepción / editar_lote.
  IF v_venc IS NOT NULL AND
     (EXTRACT(YEAR FROM v_venc) < 2000 OR EXTRACT(YEAR FROM v_venc) > 2100) THEN
    v_venc := NULL;
  END IF;
  v_venc := v_row.fecha_vencimiento;

  v_codigo := UPPER(TRIM(v_row.codigo));
  v_descripcion := v_row.descripcion;
  v_un := v_row.unidad_medida;
  v_prov := v_row.proveedor;

  IF p_tipo_destino = 'rack' THEN
    IF p_rack IS NULL OR COALESCE(p_rack ->> 'bloque', '') = '' THEN
      RAISE EXCEPTION 'UBICACION_RACK_REQUERIDA|Falta la ubicación del rack (bloque/torre/piso/posición)';
    END IF;
    -- Ingreso NATIVO en Racks (misma RPC que usa el módulo) — misma transacción:
    -- si esto falla, NO se marca nada en Tránsito. Acepta v_venc NULL y
    -- lote NULL ('' → NULLIF: "sin lote" en un solo convenio).
    v_res := public.registrar_movimiento_kardex(
      'ingreso',
      p_rack ->> 'bloque', p_rack ->> 'torre', p_rack ->> 'piso', p_rack ->> 'posicion',
      v_codigo, v_descripcion, v_un, p_cantidad, v_venc, p_turno,
      p_usuario_id, p_usuario_nombre, p_usuario_correo, v_prov,
      p_uuid_sync, NULL, NULLIF(v_lote, '')
    );
  ELSE
    IF p_piso IS NULL OR COALESCE(p_piso ->> 'nivel_id', '') = '' THEN
      RAISE EXCEPTION 'UBICACION_PISO_REQUERIDA|Falta el nivel de destino del piso';
    END IF;

    -- Bloque del catálogo Piso: resolver por código; crearlo si no existe
    -- (puente Recepción → Piso sin doble digitación).
    SELECT id INTO v_bloque_piso_id FROM public.piso_bloques WHERE codigo = v_codigo;
    IF NOT FOUND THEN
      INSERT INTO public.piso_bloques (codigo, descripcion, unidad)
      VALUES (v_codigo, v_descripcion, v_un)
      ON CONFLICT (codigo) DO NOTHING;
      SELECT id INTO v_bloque_piso_id FROM public.piso_bloques WHERE codigo = v_codigo;
    END IF;

    -- Ingreso NATIVO en Piso (cabecera + detalle, igual que registrarIngresoPosicion).
    -- fecha_vencimiento y lote son nullable: NULL = sin dato (se completa luego).
    INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, posicion_id)
    VALUES (
      'ingreso', p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo,
      p_uuid_sync, NULLIF(p_piso ->> 'posicion_id', '')::uuid
    ) RETURNING id INTO v_mov_id;

    INSERT INTO public.piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    VALUES (v_mov_id, (p_piso ->> 'nivel_id')::uuid, v_bloque_piso_id, p_cantidad, v_venc, NULLIF(v_lote, ''));
  END IF;

  -- Marca TRÁNSITO sobre la fila de recepción (historial completo por artículo)
  v_nuevo := jsonb_build_object(
    'uuid', p_uuid_sync,
    'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
    'destino', p_tipo_destino,
    'ubicacion', COALESCE(p_ubicacion, ''),
    'cantidad', p_cantidad,
    'usuario_id', p_usuario_id,
    'usuario_nombre', p_usuario_nombre,
    'turno', p_turno,
    'rack', p_rack,
    'piso', p_piso
  );
  UPDATE public.recepcion_registros
  SET transito = jsonb_build_object('v', 1, 'envios', (v_envios || jsonb_build_array(v_nuevo)))
  WHERE id = p_recepcion_id;

  v_enviados := v_enviados + p_cantidad;
  v_pendiente := v_row.cantidad - v_enviados;
  RETURN jsonb_build_object(
    'ok', true,
    'duplicado', false,
    'recepcion_id', p_recepcion_id,
    'enviados', v_enviados,
    'pendiente', v_pendiente,
    'estado', CASE WHEN v_pendiente <= 0 THEN 'COMPLETO' ELSE 'PARCIAL' END
  );
END;
$function$

CREATE OR REPLACE FUNCTION public.rq_atender_item(p_item_id uuid, p_cantidad numeric, p_usuario text)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
declare
  v_item rq_atencion_items%ROWTYPE;
  v_pendientes integer;
begin
  -- v8 (auditoría 2026-10-23): guard de rol, consistente con rq_atender_lote.
  -- Antes la función tenía EXECUTE para PUBLIC: anon recibía un confuso
  -- 'Artículo no encontrado' en vez de un NO_AUTORIZADO claro.
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden atender materiales';
  END IF;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a atender debe ser mayor que cero';
  end if;

  -- v8: incremento ATÓMICO en un solo UPDATE (los refs de columna en SET usan
  -- la fila ya bloqueada por el propio UPDATE). Antes era read-modify-write:
  -- dos atenciones simultáneas del mismo ítem (doble tap / dos celulares)
  -- leían el mismo saldo y una de las dos se perdía.
  update rq_atencion_items set
    cantidad_atendida = cantidad_atendida + p_cantidad,
    usuario_atencion = coalesce(nullif(p_usuario, ''), usuario_atencion),
    atendido_en = case when cantidad_atendida + p_cantidad >= cantidad then now() else null end
  where id = p_item_id
  returning * into v_item;

  if not found then
    raise exception 'Artículo no encontrado (puede haber sido eliminado)';
  end if;

  select count(*) into v_pendientes
    from rq_atencion_items
    where rq_id = v_item.rq_id and cantidad_atendida < cantidad;

  update rq_atenciones set
    estado = case when v_pendientes = 0 then 'Atendido' else 'En proceso' end
  where id = v_item.rq_id;

  return to_json(v_item);
end $function$

CREATE OR REPLACE FUNCTION public.rq_revertir_item(p_item_id uuid, p_cantidad numeric)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
declare
  v_item rq_atencion_items%ROWTYPE;
  v_pendientes integer;
begin
  -- v8 (auditoría 2026-10-23): guard de rol + decremento ATÓMICO (mismo
  -- patrón que rq_atender_item; evita update perdido en reversiones simultáneas).
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden revertir atenciones';
  END IF;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a revertir debe ser mayor que cero';
  end if;

  update rq_atencion_items set
    cantidad_atendida = greatest(cantidad_atendida - p_cantidad, 0),
    atendido_en = case when greatest(cantidad_atendida - p_cantidad, 0) >= cantidad then atendido_en else null end
  where id = p_item_id
  returning * into v_item;

  if not found then
    raise exception 'Artículo no encontrado';
  end if;

  select count(*) into v_pendientes
    from rq_atencion_items
    where rq_id = v_item.rq_id and cantidad_atendida < cantidad;
  update rq_atenciones set
    estado = case
      when v_pendientes = 0 then 'Atendido'
      when v_pendientes = (select count(*) from rq_atencion_items where rq_id = v_item.rq_id) then 'Pendiente'
      else 'En proceso' end
  where id = v_item.rq_id;

  return to_json(v_item);
end $function$

REVOKE EXECUTE ON FUNCTION public.rq_atender_item(uuid, numeric, text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.rq_revertir_item(uuid, numeric) FROM PUBLIC;
