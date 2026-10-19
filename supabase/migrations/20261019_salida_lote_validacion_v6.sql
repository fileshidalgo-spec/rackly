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
  -- Los 11 negativos de atribución nacidos 17-19 oct (tras el fix v5) venían
  -- de salidas CON lote que no cubría (lote mal digitado o agotado, p.ej.
  -- SO00432338 vs SO000432338): la RPC lo aceptaba a ciegas. Si el bucket del
  -- lote recibido no cubre la cantidad, se descarta y la fila cae al pipeline
  -- v4/v5 de abajo (FEFO cubierta -> sin-lote -> lote de mayor saldo).
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
    -- 2) v5 · si ningún lote físico cubre sola, dejar NULL cuando el bucket
    --    "sin lote" tiene saldo suficiente: su superávit absorbe la salida
    --    sin fabricar negativos por lote (regresión observada en producción)
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
    -- 3) último recurso: el lote físico de mayor saldo (salida que abarcó
    --    varios lotes) — solo si el bucket "sin lote" tampoco cubre
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
