-- ═══════════════════════════════════════════════════════════════════════════════
-- RACKLY PISO — FIX DEFINITIVO (JHIA-58)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- PROBLEMA: Las salidas en Kardex Piso no reducen el stock visible.
-- RAIZ: La columna fecha_vencimiento NO existe en piso_movimiento_detalles,
--        los RPCs de calculo de stock NO existen, y el fallback del frontend
--        falla al intentar seleccionar una columna inexistente.
--
-- EJECUTAR COMPLETO en Supabase Dashboard > SQL Editor
-- (Seleccionar TODO y darle "Run")
-- ═══════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════
-- PASO 1: Agregar columna fecha_vencimiento si no existe
-- ═══════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name  = 'piso_movimiento_detalles'
      AND column_name = 'fecha_vencimiento'
  ) THEN
    ALTER TABLE public.piso_movimiento_detalles
      ADD COLUMN fecha_vencimiento DATE;
    RAISE NOTICE '✅ Columna fecha_vencimiento CREADA en piso_movimiento_detalles';
  ELSE
    RAISE NOTICE '✅ Columna fecha_vencimiento ya existe';
  END IF;
END $$;

COMMENT ON COLUMN public.piso_movimiento_detalles.fecha_vencimiento
  IS 'Fecha de vencimiento del lote. NULL = sin fecha registrada.';


-- ═══════════════════════════════════════════════════════════════════
-- PASO 2: Indices para rendimiento
-- ═══════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS
  idx_piso_mov_detalles_fecha_venc
  ON public.piso_movimiento_detalles (fecha_vencimiento)
  WHERE fecha_vencimiento IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  idx_piso_mov_detalles_nivel_bloque
  ON public.piso_movimiento_detalles (nivel_id, bloque_id);


-- ═══════════════════════════════════════════════════════════════════
-- PASO 3: RPC piso_stock_detalle_posicion
-- Calcula el stock REAL por bloque en una posicion usando FEFO.
-- Descontara TODAS las salidas sin importar fecha_vencimiento.
-- ═══════════════════════════════════════════════════════════════════
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
STABLE
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
        -- Sin salidas pendientes -> retornar lote completo
        bloque_id          := v_bloque_rec.bloque_id;
        bloque_codigo      := v_bloque_info.codigo;
        bloque_descripcion := v_bloque_info.descripcion;
        bloque_unidad      := v_bloque_info.unidad;
        cantidad           := v_lot.ingreso_qty;
        fecha_vencimiento  := COALESCE(v_lot.fecha_vencimiento::TEXT, '');
        RETURN NEXT;

      ELSIF v_lot.ingreso_qty <= v_pendiente THEN
        -- Lote consumido completamente por salidas
        v_pendiente := v_pendiente - v_lot.ingreso_qty;

      ELSE
        -- Consumo parcial -> retornar sobrante
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
  'Calcula stock por bloque en una posicion usando FEFO. '
  'Descuenta TODAS las salidas de los lotes de ingreso.';


-- ═══════════════════════════════════════════════════════════════════
-- PASO 4: RPC piso_stock_sector_grid
-- Grilla de posiciones con stock > 0 para un sector.
-- ═══════════════════════════════════════════════════════════════════
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
STABLE
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
  'Retorna grilla de posiciones con stock > 0 para un sector. '
  'Incluye stock neto y detalle por bloque en JSONB.';


-- ═══════════════════════════════════════════════════════════════════
-- PASO 5: Actualizar piso_registrar_movimiento
-- Ahora acepta fecha_vencimiento en el JSONB de detalles.
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.piso_registrar_movimiento(
  _tipo     TEXT,
  _turno    TEXT,
  _detalles JSONB DEFAULT '[]'::JSONB
)
RETURNS SETOF public.piso_movimientos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mov_id   UUID;
  v_det      JSONB;
  v_fv       TEXT;
  v_fv_date  DATE;
BEGIN
  INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo)
  VALUES (_tipo, _turno, NULL, NULL, NULL)
  RETURNING id INTO v_mov_id;

  FOR v_det IN SELECT * FROM jsonb_array_elements(_detalles)
  LOOP
    v_fv := v_det->>'fecha_vencimiento';

    IF v_fv IS NOT NULL AND v_fv != '' AND v_fv != 'null' THEN
      BEGIN
        v_fv_date := to_date(v_fv, 'YYYY-MM-DD');
      EXCEPTION WHEN OTHERS THEN
        v_fv_date := (v_fv::TIMESTAMPTZ)::DATE;
      END;
    ELSE
      v_fv_date := NULL;
    END IF;

    INSERT INTO public.piso_movimiento_detalles (
      movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento
    )
    VALUES (
      v_mov_id,
      (v_det->>'nivel_id')::UUID,
      (v_det->>'bloque_id')::UUID,
      COALESCE((v_det->>'cantidad')::NUMERIC, 0),
      v_fv_date
    );
  END LOOP;

  RETURN QUERY SELECT * FROM public.piso_movimientos WHERE id = v_mov_id;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════
-- PASO 6: Verificacion — Confirma que todo se creo correctamente
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_col_exists BOOLEAN;
  v_rpc1_exists BOOLEAN;
  v_rpc2_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'piso_movimiento_detalles' AND column_name = 'fecha_vencimiento'
  ) INTO v_col_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'piso_stock_detalle_posicion'
  ) INTO v_rpc1_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'piso_stock_sector_grid'
  ) INTO v_rpc2_exists;

  RAISE NOTICE '═══════════════════════════════════════';
  RAISE NOTICE 'VERIFICACION FINAL:';
  RAISE NOTICE '  fecha_vencimiento columna: %', CASE WHEN v_col_exists THEN '✅ SI' ELSE '❌ NO' END;
  RAISE NOTICE '  piso_stock_detalle_posicion RPC: %', CASE WHEN v_rpc1_exists THEN '✅ SI' ELSE '❌ NO' END;
  RAISE NOTICE '  piso_stock_sector_grid RPC: %', CASE WHEN v_rpc2_exists THEN '✅ SI' ELSE '❌ NO' END;

  IF v_col_exists AND v_rpc1_exists AND v_rpc2_exists THEN
    RAISE NOTICE '═══════════════════════════════════════';
    RAISE NOTICE '✅ TODO INSTALADO CORRECTAMENTE';
    RAISE NOTICE '═══════════════════════════════════════';
  ELSE
    RAISE NOTICE '═══════════════════════════════════════';
    RAISE NOTICE '❌ ALGO FALLÓ — revisa los errores arriba';
    RAISE NOTICE '═══════════════════════════════════════';
  END IF;
END $$;
