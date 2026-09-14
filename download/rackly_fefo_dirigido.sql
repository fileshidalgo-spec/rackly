-- ═══════════════════════════════════════════════════════════════════════════════
-- RACKLY — Actualizar piso_stock_detalle_posicion al algoritmo FEFO dirigido + desborde
-- (Opción C: la salida descuenta el lote ELEGIDO por el usuario, no FEFO forzado)
--
-- OPCIONAL: la app ya usa cálculo client-side con esta semántica (piso/api.ts).
-- Aplica este script en Supabase SQL Editor si quieres devolver el cálculo al
-- servidor (mejor rendimiento). Para revertir: re-ejecutar la versión anterior
-- (rackly_piso_fix_jhia59.sql, PASO 1).
--
-- Semántica (idéntica al client-side):
--   * SALIDA con fecha F  -> descuenta PRIMERO del lote con fecha F; el exceso
--                            desborda en orden FEFO (fechas ASC, sin fecha al final).
--   * SALIDA sin fecha    -> descuenta PRIMERO del lote sin fecha; el exceso desborda FEFO.
--   * Ningún lote queda en negativo. Stock total = ingresos - salidas.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.piso_stock_detalle_posicion(
  _posicion_id UUID
)
RETURNS TABLE(
  bloque_id          UUID,
  bloque_codigo      TEXT,
  bloque_descripcion TEXT,
  bloque_unidad      TEXT,
  cantidad           NUMERIC,
  fecha_vencimiento  TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nivel_ids   UUID[];
  v_bloque_rec  RECORD;
  v_bloque_info RECORD;
  v_sal         RECORD;
  v_lot         RECORD;
  v_vencs       DATE[];
  v_qtys        NUMERIC[];
  v_n           INT;
  v_i           INT;
  v_pendiente   NUMERIC;
  v_tomar       NUMERIC;
BEGIN
  -- Niveles de la posición
  SELECT ARRAY_AGG(n.id) INTO v_nivel_ids
  FROM public.piso_niveles n
  WHERE n.posicion_id = _posicion_id;

  IF v_nivel_ids IS NULL OR array_length(v_nivel_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Recorrer cada bloque con movimientos en estos niveles
  FOR v_bloque_rec IN
    SELECT DISTINCT d.bloque_id
    FROM public.piso_movimiento_detalles d
    WHERE d.nivel_id = ANY(v_nivel_ids)
  LOOP
    SELECT b.codigo, b.descripcion, b.unidad
    INTO v_bloque_info
    FROM public.piso_bloques b
    WHERE b.id = v_bloque_rec.bloque_id;

    IF v_bloque_info IS NULL THEN
      CONTINUE;
    END IF;

    -- ── Pool de ingresos por lote (ordenado FEFO: fechas ASC, sin fecha al final) ──
    v_vencs := NULL;
    v_qtys  := NULL;
    FOR v_lot IN
      SELECT d.fecha_vencimiento AS fv, SUM(d.cantidad) AS ingreso_qty
      FROM public.piso_movimiento_detalles d
      JOIN public.piso_movimientos m ON m.id = d.movimiento_id
      WHERE d.bloque_id = v_bloque_rec.bloque_id
        AND d.nivel_id  = ANY(v_nivel_ids)
        AND m.tipo      IN ('ingreso', 'stock_inicial', 'devolucion')
      GROUP BY d.fecha_vencimiento
      ORDER BY d.fecha_vencimiento ASC NULLS LAST
    LOOP
      v_vencs := array_append(v_vencs, v_lot.fv);
      v_qtys  := array_append(v_qtys, GREATEST(COALESCE(v_lot.ingreso_qty, 0), 0));
    END LOOP;
    v_n := COALESCE(array_length(v_qtys, 1), 0);

    -- ── Salidas en orden temporal: dirigidas a su lote + desborde FEFO ──
    FOR v_sal IN
      SELECT d.fecha_vencimiento AS fv, d.cantidad AS q
      FROM public.piso_movimiento_detalles d
      JOIN public.piso_movimientos m ON m.id = d.movimiento_id
      WHERE d.bloque_id = v_bloque_rec.bloque_id
        AND d.nivel_id  = ANY(v_nivel_ids)
        AND m.tipo      = 'salida'
      ORDER BY m.fecha ASC NULLS LAST
    LOOP
      v_pendiente := COALESCE(v_sal.q, 0);
      IF v_pendiente <= 0 THEN CONTINUE; END IF;

      -- Dirigida: primero el lote con la MISMA fecha registrada en la salida
      IF v_sal.fv IS NOT NULL THEN
        FOR v_i IN 1..v_n LOOP
          EXIT WHEN v_pendiente <= 0;
          IF v_vencs[v_i] IS NOT DISTINCT FROM v_sal.fv AND v_qtys[v_i] > 0 THEN
            v_tomar := LEAST(v_qtys[v_i], v_pendiente);
            v_qtys[v_i] := v_qtys[v_i] - v_tomar;
            v_pendiente := v_pendiente - v_tomar;
          END IF;
        END LOOP;
      ELSE
        -- Sin fecha: primero el lote sin fecha
        FOR v_i IN 1..v_n LOOP
          EXIT WHEN v_pendiente <= 0;
          IF v_vencs[v_i] IS NULL AND v_qtys[v_i] > 0 THEN
            v_tomar := LEAST(v_qtys[v_i], v_pendiente);
            v_qtys[v_i] := v_qtys[v_i] - v_tomar;
            v_pendiente := v_pendiente - v_tomar;
          END IF;
        END LOOP;
      END IF;

      -- Desborde FEFO: los arrays ya están ordenados (fechas ASC, NULL al final)
      IF v_pendiente > 0 THEN
        FOR v_i IN 1..v_n LOOP
          EXIT WHEN v_pendiente <= 0;
          IF v_qtys[v_i] > 0 THEN
            v_tomar := LEAST(v_qtys[v_i], v_pendiente);
            v_qtys[v_i] := v_qtys[v_i] - v_tomar;
            v_pendiente := v_pendiente - v_tomar;
          END IF;
        END LOOP;
      END IF;
    END LOOP;

    -- ── Devolver remanentes (orden FEFO, sin negativos) ──
    FOR v_i IN 1..v_n LOOP
      IF v_qtys[v_i] > 0 THEN
        bloque_id          := v_bloque_rec.bloque_id;
        bloque_codigo      := v_bloque_info.codigo;
        bloque_descripcion := v_bloque_info.descripcion;
        bloque_unidad      := v_bloque_info.unidad;
        cantidad           := v_qtys[v_i];
        fecha_vencimiento  := COALESCE(v_vencs[v_i]::TEXT, '');
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.piso_stock_detalle_posicion(UUID) IS
  'Stock por lotes de una posicion con FEFO dirigido: cada salida descuenta '
  'primero el lote con la fecha registrada en el movimiento de salida (el elegido '
  'por el usuario); salida sin fecha descuenta primero el lote sin fecha; el exceso '
  'desborda en orden FEFO. Nunca deja lotes negativos.';
