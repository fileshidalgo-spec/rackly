-- ═══════════════════════════════════════════════════════════════════
-- JHIA-59: Fix stock no se descuenta tras salida + mostrar cantidades
--
-- PROBLEMA 1: Los RPCs piso_stock_detalle_posicion y piso_stock_sector_grid
--   fueron creados como STABLE. En PostgreSQL, STABLE permite al planner
--   cachear resultados dentro de ciertos escenarios (especialmente con
--   PgBouncer de Supabase). Esto impide que las funciones lean datos
--   recién insertados en la misma sesión o conexiones pooladas.
--   SOLUCION: Cambiar a VOLATILE para garantizar lectura fresca siempre.
--
-- PROBLEMA 2: Las celdas del grid no muestran la cantidad de stock.
--   (Este es un fix del frontend, no de SQL)
-- ═══════════════════════════════════════════════════════════════════

-- PASO 1: Cambiar piso_stock_detalle_posicion de STABLE a VOLATILE
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
  v_nivel_ids     UUID[];
  v_bloque_rec    RECORD;
  v_total_salida  NUMERIC;
  v_pendiente     NUMERIC;
  v_lot           RECORD;
  v_bloque_info   RECORD;
BEGIN
  -- Obtener todos los niveles de la posicion
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
    -- Total de salidas para este bloque (sin importar fecha_vencimiento)
    SELECT COALESCE(SUM(d.cantidad), 0)
    INTO v_total_salida
    FROM public.piso_movimiento_detalles d
    JOIN public.piso_movimientos m ON m.id = d.movimiento_id
    WHERE d.bloque_id = v_bloque_rec.bloque_id
      AND d.nivel_id  = ANY(v_nivel_ids)
      AND m.tipo      = 'salida';

    -- Info del bloque
    SELECT b.codigo, b.descripcion, b.unidad
    INTO v_bloque_info
    FROM public.piso_bloques b
    WHERE b.id = v_bloque_rec.bloque_id;

    IF v_bloque_info IS NULL THEN
      CONTINUE;
    END IF;

    -- Recorrer lotes de ingreso en orden FEFO
    v_pendiente := v_total_salida;

    FOR v_lot IN
      SELECT
        d.fecha_vencimiento,
        SUM(d.cantidad) AS ingreso_qty
      FROM public.piso_movimiento_detalles d
      JOIN public.piso_movimientos m ON m.id = d.movimiento_id
      WHERE d.bloque_id = v_bloque_rec.bloque_id
        AND d.nivel_id  = ANY(v_nivel_ids)
        AND m.tipo      IN ('ingreso', 'stock_inicial', 'devolucion')
      GROUP BY d.fecha_vencimiento
      ORDER BY d.fecha_vencimiento ASC NULLS LAST
    LOOP
      IF v_pendiente <= 0 THEN
        bloque_id          := v_bloque_rec.bloque_id;
        bloque_codigo      := v_bloque_info.codigo;
        bloque_descripcion := v_bloque_info.descripcion;
        bloque_unidad      := v_bloque_info.unidad;
        cantidad           := v_lot.ingreso_qty;
        fecha_vencimiento  := COALESCE(v_lot.fecha_vencimiento::TEXT, '');
        RETURN NEXT;

      ELSIF v_lot.ingreso_qty <= v_pendiente THEN
        v_pendiente := v_pendiente - v_lot.ingreso_qty;

      ELSE
        bloque_id          := v_bloque_rec.bloque_id;
        bloque_codigo      := v_bloque_info.codigo;
        bloque_descripcion := v_bloque_info.descripcion;
        bloque_unidad      := v_bloque_info.unidad;
        cantidad           := (v_lot.ingreso_qty - v_pendiente);
        fecha_vencimiento  := COALESCE(v_lot.fecha_vencimiento::TEXT, '');
        RETURN NEXT;
        v_pendiente := 0;
      END IF;
    END LOOP;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.piso_stock_detalle_posicion(UUID) IS
  'Calcula stock por bloque en una posicion usando FEFO. VOLATILE para leer datos frescos siempre.';


-- PASO 2: Cambiar piso_stock_sector_grid de STABLE a VOLATILE
CREATE OR REPLACE FUNCTION public.piso_stock_sector_grid(
  _sector_id UUID
)
RETURNS TABLE(
  posicion_id       UUID,
  posicion_numero   INTEGER,
  subcolumna_codigo TEXT,
  columna_letra     TEXT,
  stock_total       NUMERIC,
  bloques_json      JSONB
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_posicion_rec  RECORD;
  v_stock_total   NUMERIC;
  v_bloques_json  JSONB;
BEGIN
  FOR v_posicion_rec IN
    SELECT
      p.id             AS posicion_id,
      p.numero         AS posicion_numero,
      sc.codigo        AS subcolumna_codigo,
      c.letra          AS columna_letra
    FROM public.piso_posiciones p
    JOIN public.piso_subcolumnas sc ON sc.id = p.subcolumna_id
    JOIN public.piso_columnas c     ON c.id = sc.columna_id
    WHERE c.sector_id = _sector_id
    ORDER BY c.letra, sc.codigo, p.numero
  LOOP
    -- Stock total neto de la posicion
    SELECT COALESCE(SUM(neto), 0)
    INTO v_stock_total
    FROM (
      SELECT
        CASE
          WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
          THEN d.cantidad
          WHEN m.tipo = 'salida'
          THEN -d.cantidad
          ELSE 0
        END AS neto
      FROM public.piso_movimiento_detalles d
      JOIN public.piso_movimientos m ON m.id = d.movimiento_id
      JOIN public.piso_niveles n      ON n.id = d.nivel_id
      WHERE n.posicion_id = v_posicion_rec.posicion_id
    ) sub;

    IF v_stock_total > 0 THEN
      -- Detalle por bloque
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'bloque_id',     bloque_id,
        'bloque_codigo', bloque_codigo,
        'descripcion',   bloque_descripcion,
        'unidad',        bloque_unidad,
        'stock',         stock
      )) FILTER (WHERE stock > 0), '[]'::jsonb)
      INTO v_bloques_json
      FROM (
        SELECT
          b.id            AS bloque_id,
          b.codigo        AS bloque_codigo,
          b.descripcion   AS bloque_descripcion,
          b.unidad        AS bloque_unidad,
          SUM(
            CASE
              WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
              THEN d.cantidad
              WHEN m.tipo = 'salida'
              THEN -d.cantidad
              ELSE 0
            END
          ) AS stock
        FROM public.piso_movimiento_detalles d
        JOIN public.piso_movimientos m ON m.id = d.movimiento_id
        JOIN public.piso_niveles n     ON n.id = d.nivel_id
        JOIN public.piso_bloques b    ON b.id = d.bloque_id
        WHERE n.posicion_id = v_posicion_rec.posicion_id
        GROUP BY b.id, b.codigo, b.descripcion, b.unidad
        HAVING SUM(
          CASE
            WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
            THEN d.cantidad
            WHEN m.tipo = 'salida'
            THEN -d.cantidad
            ELSE 0
          END
        ) > 0
      ) bloque_stock;

      posicion_id        := v_posicion_rec.posicion_id;
      posicion_numero    := v_posicion_rec.posicion_numero;
      subcolumna_codigo  := v_posicion_rec.subcolumna_codigo;
      columna_letra      := v_posicion_rec.columna_letra;
      stock_total        := v_stock_total;
      bloques_json       := v_bloques_json;
      RETURN NEXT;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.piso_stock_sector_grid(UUID) IS
  'Retorna grilla de posiciones con stock > 0 para un sector. VOLATILE para leer datos frescos siempre.';


-- ═══ VERIFICACION ═══
DO $$
DECLARE
  v_rpc1_is_volatile BOOLEAN;
  v_rpc2_is_volatile BOOLEAN;
BEGIN
  SELECT volatility = 'v' INTO v_rpc1_is_volatile
  FROM pg_proc WHERE proname = 'piso_stock_detalle_posicion';

  SELECT volatility = 'v' INTO v_rpc2_is_volatile
  FROM pg_proc WHERE proname = 'piso_stock_sector_grid';

  RAISE NOTICE '=== JHIA-59 VERIFICACION ===';
  RAISE NOTICE '  piso_stock_detalle_posicion VOLATILE: %', CASE WHEN v_rpc1_is_volatile THEN 'SI' ELSE 'NO' END;
  RAISE NOTICE '  piso_stock_sector_grid VOLATILE: %', CASE WHEN v_rpc2_is_volatile THEN 'SI' ELSE 'NO' END;

  IF v_rpc1_is_volatile AND v_rpc2_is_volatile THEN
    RAISE NOTICE '  RESULTADO: TODO CORRECTO';
  ELSE
    RAISE NOTICE '  RESULTADO: HAY PROBLEMAS - revisar las funciones';
  END IF;
END $$;
