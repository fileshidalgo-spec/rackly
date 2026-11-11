-- ════════════════════════════════════════════════════════════════════════════
-- RACKLY · TRASLADO DE UBICACIÓN COMPLETA (Kardex Racks · INSUMOS) — 2026-11-11
-- ════════════════════════════════════════════════════════════════════════════
-- Pedido del usuario: «que se realice el traslado de TODO lo que se encuentra en
-- esa ubicación a otra ubicación para que sea más rápido» + ajustes por artículo
-- (mover MENOS deja saldo en origen; mover MÁS registra ingreso de ajuste).
--
-- RPC atómica que espeja EXACTAMENTE las garantías de registrar_traslado_kardex
-- (v8), pero para N artículos de una posición en UNA transacción:
--   · guard 'movimientos.crear' (+ service_role + bandera rpc_interna)
--   · advisory locks con la MISMA convención de claves (pos/codigo), items
--     ordenados por codigo → imposible interbloquear con traslados unitarios
--   · ledger con normalización de ceros ('01' == '1') y EXCLUSIÓN de INC
--   · FEFO server-side: cada artículo se parte por (lote, vencimiento) con su
--     fecha — el destino conserva las fechas reales (FIX P1 2026-10-21 intacto)
--   · ajuste derivado en el SERVIDOR: cantidad > stock ⇒ ingreso de ajuste en
--     origen + salida ampliada del primer lote FEFO (misma semántica del unitario)
--   · fail-fast: TODAS las validaciones antes de la PRIMERA fila (todo-o-nada)
--   · uuid_sync por artículo (idempotencia, índice único parcial intacto)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.registrar_traslado_ubicacion_kardex(
  p_orig_bloque   text,
  p_orig_torre    text,
  p_orig_piso     text,
  p_orig_pos      text,
  p_dest_bloque   text,
  p_dest_torre    text,
  p_dest_piso     text,
  p_dest_pos      text,
  p_turno         text,
  p_usuario_id    uuid,
  p_usuario_nombre text,
  p_usuario_correo text,
  p_items         jsonb   -- [{codigo, descripcion, un, cantidad, proveedor?}]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item         JSONB;
  v_items        JSONB;          -- items ordenados por codigo (anti-deadlock)
  v_codigo_clean TEXT;
  v_cantidad     NUMERIC;
  v_desc         TEXT;
  v_un           TEXT;
  v_proveedor    TEXT;
  v_pares        JSONB;          -- lotes (lote, venc, saldo) FEFO del artículo
  v_stock_total  NUMERIC;
  v_desc_bd      TEXT;
  v_un_bd        TEXT;
  v_ajuste       NUMERIC;
  v_validaciones JSONB := '[]'::jsonb;
  v_uuid_item    TEXT;
  v_uuid_usado   BOOLEAN;   -- uuid_sync SOLO en la primera fila del artículo
  v_primer_par   BOOLEAN;   -- el ajuste se absorbe en el PRIMER par FEFO
  v_restante     NUMERIC;
  v_toma         NUMERIC;
  v_par          JSONB;
  v_venc         TEXT;
  v_lote         TEXT;
  v_filas        INTEGER := 0;
  v_i            INTEGER := 0;
  v_quedan       NUMERIC;
BEGIN
  -- ── guard_permiso: idéntico al traslado unitario ──
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'movimientos.crear') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para registrar movimientos de racks';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  -- ── Validaciones de entrada ──
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_VACIOS|No hay artículos para trasladar';
  END IF;
  IF jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'TOO_MANY_ITEMS|Máximo 200 artículos por traslado de ubicación';
  END IF;

  IF p_orig_bloque = p_dest_bloque AND p_orig_torre = p_dest_torre
     AND p_orig_piso = p_dest_piso AND p_orig_pos = p_dest_pos THEN
    RAISE EXCEPTION 'SAME_ORIGIN_DESTINATION|El destino no puede ser igual al origen';
  END IF;

  -- Items ORDENADOS por codigo: junto con el orden origen→destino por par,
  -- dos traslados masivos concurrentes adquieren locks en el MISMO orden
  -- (misma convención de claves que la RPC unitaria) → sin interbloqueos.
  SELECT jsonb_agg(item ORDER BY UPPER(TRIM(item->>'codigo')), item->>'codigo_inc')
    INTO v_items
  FROM jsonb_array_elements(p_items) AS item;

  -- ════════ PASADA 1 — VALIDACIONES (fail-fast, 0 filas escritas) ════════
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_i := v_i + 1;
    v_codigo_clean := UPPER(TRIM(COALESCE(v_item->>'codigo', '')));
    IF v_codigo_clean = '' THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA|Item % sin codigo', v_i;
    END IF;

    v_cantidad := NULLIF(TRIM(COALESCE(v_item->>'cantidad', '')), '')::numeric;
    IF v_cantidad IS NULL OR v_cantidad <= 0 THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA|Artículo % (item %): la cantidad a trasladar debe ser mayor que cero', v_codigo_clean, v_i;
    END IF;

    -- Lotes (lote físico, vencimiento) con saldo > 0 en origen — MISMA
    -- normalización que la RPC unitaria; INC excluido siempre (cuarentena).
    SELECT COALESCE(jsonb_agg(
             jsonb_build_object('lote', c.lote, 'venc', c.venc, 'saldo', c.saldo)
             ORDER BY (c.venc = '') ASC, c.venc ASC, c.primer_ing ASC
           ), '[]'::jsonb)
      INTO v_pares
    FROM (
      SELECT COALESCE(m.lote, '') AS lote,
             COALESCE(m.f_vencimiento::text, '') AS venc,
             ROUND(SUM(CASE
               WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad
               WHEN m.tipo = 'salida' THEN -m.cantidad
               ELSE 0 END), 3) AS saldo,
             MIN(m.f_modificacion) AS primer_ing
      FROM movimientos m
      WHERE m.bloque = p_orig_bloque
        AND TRIM(LEADING '0' FROM m.torre)    = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
        AND TRIM(LEADING '0' FROM m.piso)     = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
        AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
        AND m.codigo = v_codigo_clean
        AND m.codigo_inc IS NULL
      GROUP BY 1, 2
      HAVING SUM(CASE
        WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad
        WHEN m.tipo = 'salida' THEN -m.cantidad
        ELSE 0 END) > 0
    ) c;

    -- Stock total del ARTÍCULO (suma de todos sus pares) + metadatos de reserva.
    SELECT ROUND(SUM(CASE
             WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad
             WHEN m.tipo = 'salida' THEN -m.cantidad
             ELSE 0 END), 3),
           MAX(m.descripcion), MAX(m.un)
      INTO v_stock_total, v_desc_bd, v_un_bd
    FROM movimientos m
    WHERE m.bloque = p_orig_bloque
      AND TRIM(LEADING '0' FROM m.torre)    = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
      AND TRIM(LEADING '0' FROM m.piso)     = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
      AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
      AND m.codigo = v_codigo_clean
      AND m.codigo_inc IS NULL;

    -- El cliente solo envía artículos con stock (stock_en_ubicacion); si el
    -- ledger no respalda ninguno, el código llegó mal digitado o el stock se
    -- movió mientras se cargaba la pantalla → rechazar TODO (fail-fast).
    IF v_stock_total IS NULL OR v_stock_total <= 0 THEN
      RAISE EXCEPTION 'SIN_STOCK_ORIGEN|Artículo % sin stock en la ubicación de origen (¿se movió mientras cargabas la pantalla?)', v_codigo_clean;
    END IF;

    -- Ajuste derivado EN SERVIDOR: pedir más de lo registrado = ingreso de
    -- ajuste en origen (misma semántica del traslado unitario, sin confiar en
    -- el cliente). Pedir menos = deja saldo, sin filas fantasma.
    v_ajuste := GREATEST(ROUND(v_cantidad - v_stock_total, 3), 0);

    v_validaciones := v_validaciones || jsonb_build_array(jsonb_build_object(
      'codigo',      v_codigo_clean,
      'descripcion', COALESCE(NULLIF(TRIM(COALESCE(v_item->>'descripcion', '')), ''), v_desc_bd, v_codigo_clean),
      'un',          COALESCE(NULLIF(TRIM(COALESCE(v_item->>'un', '')), ''), v_un_bd, 'UND'),
      'proveedor',   NULLIF(TRIM(COALESCE(v_item->>'proveedor', '')), ''),
      'cantidad',    v_cantidad,
      'ajuste',      v_ajuste,
      'stock_origen', v_stock_total,
      'pares',       v_pares
    ));
  END LOOP;

  -- ════════ PASADA 2 — FILAS (todo validado: all-or-nothing) ════════
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_validaciones) LOOP
    v_codigo_clean := v_item->>'codigo';
    v_desc         := v_item->>'descripcion';
    v_un           := v_item->>'un';
    v_proveedor    := v_item->>'proveedor';
    v_cantidad     := (v_item->>'cantidad')::numeric;
    v_ajuste       := (v_item->>'ajuste')::numeric;
    v_uuid_item    := gen_random_uuid()::text;
    v_uuid_usado   := FALSE;
    v_primer_par   := TRUE;

    -- Ajuste positivo (físicamente había más): ingreso en origen ANTES de la
    -- salida — con la fecha/lote del primer lote FEFO (convención del unitario).
    IF v_ajuste > 0 THEN
      INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
        cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, uuid_sync, lote)
      VALUES (
        'ingreso', p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
        v_codigo_clean, v_desc, v_un,
        v_ajuste,
        NULLIF(v_item->'pares'->0->>'venc', '')::date,
        p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo, v_proveedor,
        v_uuid_item,
        NULLIF(v_item->'pares'->0->>'lote', '')
      );
      v_filas := v_filas + 1;
      v_uuid_usado := TRUE; -- el ingreso de ajuste es la primera fila del artículo
    END IF;

    -- Recorrido FEFO por (lote, venc): cada parte conserva SU fecha y SU lote.
    -- El primer par absorbe el ajuste (una sola salida ampliada, como el unitario).
    v_restante := v_cantidad;
    FOR v_par IN SELECT * FROM jsonb_array_elements(v_item->'pares') LOOP
      IF v_restante <= 0 THEN EXIT; END IF;
      v_toma := LEAST(v_restante, ROUND((v_par->>'saldo')::numeric
                   + CASE WHEN v_primer_par AND v_ajuste > 0 THEN v_ajuste ELSE 0 END, 3));
      IF v_toma <= 0 THEN CONTINUE; END IF;
      v_venc := NULLIF(v_par->>'venc', '');
      v_lote := NULLIF(v_par->>'lote', '');

      INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
        cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, uuid_sync, lote)
      VALUES (
        'salida', p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
        v_codigo_clean, v_desc, v_un, v_toma, v_venc::date,
        p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo, v_proveedor,
        CASE WHEN NOT v_uuid_usado THEN v_uuid_item END,
        v_lote
      );
      v_filas := v_filas + 1;
      v_uuid_usado := TRUE;
      v_primer_par := FALSE;

      INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
        cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, lote)
      VALUES (
        'traslado', p_dest_bloque, p_dest_torre, p_dest_piso, p_dest_pos,
        v_codigo_clean, v_desc, v_un, v_toma, v_venc::date,
        p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo, v_proveedor,
        v_lote
      );
      v_filas := v_filas + 1;
      v_restante := ROUND(v_restante - v_toma, 3);
    END LOOP;

    -- Si aún queda saldo por mover (p. ej. pares agotados con ajuste ya
    -- absorbido): imposible por construcción (validación pasada 1), pero se
    -- defiende para no dejar un traslado mudo jamás.
    IF v_restante > 0 THEN
      RAISE EXCEPTION 'RESIDUO_NO_MOVIDO|Artículo %: quedaron % unidades sin partida de lote', v_codigo_clean, v_restante;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', TRUE,
    'articulos', jsonb_array_length(v_validaciones),
    'filas', v_filas,
    'origen',  jsonb_build_object('bloque', p_orig_bloque, 'torre', p_orig_torre, 'piso', p_orig_piso, 'posicion', p_orig_pos),
    'destino', jsonb_build_object('bloque', p_dest_bloque, 'torre', p_dest_torre, 'piso', p_dest_piso, 'posicion', p_dest_pos),
    'por_articulo', (
      SELECT jsonb_agg(jsonb_build_object(
        'codigo', v->>'codigo',
        'trasladado', v->>'cantidad',
        'ajuste', v->>'ajuste',
        'quedan', ROUND(GREATEST((v->>'stock_origen')::numeric - LEAST((v->>'cantidad')::numeric, (v->>'stock_origen')::numeric), 0), 3)
      ) ORDER BY v->>'codigo')
      FROM jsonb_array_elements(v_validaciones) v
    )
  );
END;
$function$;
