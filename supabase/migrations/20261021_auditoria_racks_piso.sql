-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — Migración 2026-10-21 · Auditoría profunda módulos Racks y Piso
-- ═══════════════════════════════════════════════════════════════════════════
-- Alcance (hallazgos P1/P2 de la auditoría):
--   1. registrar_movimiento_kardex v7: rechazar cantidad <= 0 (antes una
--      "salida" negativa SUMABA stock y un ingreso negativo RESTABA).
--   2. registrar_traslado_kardex v7: el ajuste positivo ingresa mercadería en
--      origen ANTES de la salida → validar contra stock + ajuste. Antes el
--      panel "Ajuste positivo" de la UI era inalcanzable (feature muerta).
--      También rechazar cantidad <= 0.
--   3. piso_registrar_movimiento v7: rechazar detalles con cantidad <= 0.
--   4. Hardening de permisos: los REVOKE de 20261016 quedaron sin efecto
--      (los deploy scripts recrean funciones y restauran ACL por defecto:
--      EXECUTE a PUBLIC). Se re-aplican a TODAS las funciones + defaults.
--   5. RPCs del módulo Usuarios requeridas al retirar service_role del
--      navegador: aprobar_usuario, eliminar_usuario, correo_existe_en_auth,
--      limpiar_perfil_huerfano (SECURITY DEFINER con guard admin/orfandad).
--   6. Realtime de Piso: piso_movimientos y piso_movimiento_detalles NO
--      estaban en la publicación supabase_realtime → la UI de Piso nunca
--      recibía eventos y quedaba desactualizada entre operarios.
--   7. Limpieza: políticas duplicadas en catalogo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1 · registrar_movimiento_kardex (v7: cantidad > 0)
-- ─────────────────────────────────────────────────────────────────────────
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
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · registrar_traslado_kardex (v7: cantidad > 0 + ajuste positivo válido)
-- ─────────────────────────────────────────────────────────────────────────
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
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3 · piso_registrar_movimiento (v7: cantidad > 0 por detalle)
-- ─────────────────────────────────────────────────────────────────────────
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
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4 · RPCs del módulo Usuarios (remplazan el uso de service_role en el
--     navegador — la app pasa al cliente anon con JWT authenticated)
-- ─────────────────────────────────────────────────────────────────────────

-- Guard compartido: service_role o admin autenticado
-- (mismo criterio que cambiar_rol_usuario, migración 20261016_hardening)

CREATE OR REPLACE FUNCTION public.aprobar_usuario(p_user_id uuid, p_aprobado boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL; -- la app (service_role): permitido
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated' OR NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    ) THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|Solo un administrador puede aprobar usuarios';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE|El perfil a modificar no existe';
  END IF;

  UPDATE public.profiles SET aprobado = p_aprobado WHERE id = p_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eliminar_usuario(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL; -- la app (service_role): permitido
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated' OR NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    ) THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|Solo un administrador puede eliminar usuarios';
    END IF;
  END IF;

  -- Protección mínima: un admin no puede eliminarse a sí mismo
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'OPERACION_INVALIDA|Un administrador no puede eliminar su propio usuario';
  END IF;

  DELETE FROM public.user_roles WHERE user_id = p_user_id;
  DELETE FROM public.profiles WHERE id = p_user_id;
END;
$function$;

-- ¿Existe el correo en Supabase Auth? (reemplaza la Admin API del navegador
-- en el flujo de registro de AuthGate; lectura segura)
CREATE OR REPLACE FUNCTION public.correo_existe_en_auth(p_correo text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_correo IS NULL OR btrim(p_correo) = '' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = lower(btrim(p_correo)));
END;
$function$;

-- Elimina un perfil huérfano (existe en profiles pero NO en auth.users).
-- La verificación de orfandad ocurre DENTRO de la función (fuente de verdad
-- auth.users): si el usuario existe en Auth, no toca nada y devuelve false.
CREATE OR REPLACE FUNCTION public.limpiar_perfil_huerfano(p_correo text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_perfil_id uuid;
BEGIN
  IF p_correo IS NULL OR btrim(p_correo) = '' THEN
    RETURN false;
  END IF;
  -- Existe en Auth → NO es huérfano: no tocar
  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = lower(btrim(p_correo))) THEN
    RETURN false;
  END IF;
  SELECT id INTO v_perfil_id FROM public.profiles WHERE lower(correo) = lower(btrim(p_correo)) LIMIT 1;
  IF v_perfil_id IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM public.user_roles WHERE user_id = v_perfil_id;
  DELETE FROM public.profiles WHERE id = v_perfil_id;
  RETURN true;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5 · Hardening de permisos de ejecución (re-aplica 20261016, ahora global)
--     Los deploy scripts recrean funciones → Postgres restaura EXECUTE a
--     PUBLIC. Con la anon key pública, cualquiera podía ejecutar
--     rackly_reemplazar_movimientos (DELETE de todo el kardex),
--     rackly_backfill_lote_fefo, editar_lote_vencimiento_*, etc.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;

-- Defaults para funciones futuras (creadas por postgres vía MAPI/CLI)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

-- Únicas RPCs pensadas para llamadas sin sesión (flujo de registro en AuthGate)
GRANT EXECUTE ON FUNCTION public.correo_existe_en_auth(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.limpiar_perfil_huerfano(text) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 6 · Realtime de Piso: agregar tablas a la publicación
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'piso_movimientos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.piso_movimientos;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'piso_movimiento_detalles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.piso_movimiento_detalles;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 7 · Limpieza: políticas duplicadas en catalogo (pares idénticos)
--     Se conservan las de nombre snake_case (convención del hardening).
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated insert catalogo" ON public.catalogo;
DROP POLICY IF EXISTS "Authenticated update catalogo" ON public.catalogo;
DROP POLICY IF EXISTS "Authenticated read catalogo" ON public.catalogo;
