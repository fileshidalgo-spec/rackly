-- ═══════════════════════════════════════════════════════════════════
-- JHIA-62: Fix bloques_json vacío en piso_stock_sector_grid
--
-- PROBLEMA: El RPC usa INNER JOIN con piso_bloques para obtener el detalle
--   por bloque. Si un bloque_id en movimiento_detalles no existe en
--   piso_bloques (IDs virtuales cat_*, manual_*, o bloques eliminados),
--   esas filas se excluyen → bloques_json = [] → nunca se muestra
--   color naranja ni conteo de artículos.
--
-- SOLUCION: Cambiar INNER JOIN a LEFT JOIN y usar COALESCE para
--   generar info del bloque a partir del bloque_id cuando no existe
--   en piso_bloques.
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
    -- Stock total neto de la posicion (sin depender de piso_bloques)
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
      -- Detalle por bloque: LEFT JOIN para incluir bloques virtuales o eliminados
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'bloque_id',     res_bloque_id,
        'bloque_codigo', res_bloque_codigo,
        'stock',         res_stock
      )) FILTER (WHERE res_stock > 0), '[]'::jsonb)
      INTO v_bloques_json
      FROM (
        SELECT
          COALESCE(b.id, d.bloque_id) AS res_bloque_id,
          COALESCE(b.codigo,
            CASE WHEN d.bloque_id LIKE 'cat_%' THEN REPLACE(d.bloque_id::TEXT, 'cat_', '')
                 WHEN d.bloque_id LIKE 'manual_%' THEN REPLACE(d.bloque_id::TEXT, 'manual_', '')
                 ELSE d.bloque_id::TEXT
            END
          ) AS res_bloque_codigo,
          SUM(
            CASE
              WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
              THEN d.cantidad
              WHEN m.tipo = 'salida'
              THEN -d.cantidad
              ELSE 0
            END
          ) AS res_stock
        FROM public.piso_movimiento_detalles d
        JOIN public.piso_movimientos m ON m.id = d.movimiento_id
        JOIN public.piso_niveles n     ON n.id = d.nivel_id
        LEFT JOIN public.piso_bloques b ON b.id = d.bloque_id
        WHERE n.posicion_id = v_posicion_rec.posicion_id
        GROUP BY COALESCE(b.id, d.bloque_id), COALESCE(b.codigo,
          CASE WHEN d.bloque_id LIKE 'cat_%' THEN REPLACE(d.bloque_id::TEXT, 'cat_', '')
               WHEN d.bloque_id LIKE 'manual_%' THEN REPLACE(d.bloque_id::TEXT, 'manual_', '')
               ELSE d.bloque_id::TEXT
          END
        )
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
  'Retorna grilla de posiciones con stock > 0 para un sector. Incluye bloques virtuales. VOLATILE.';


-- ═══ VERIFICACION ═══
DO $$
DECLARE
  v_result JSONB;
  v_count  INTEGER;
BEGIN
  -- Obtener el primer sector disponible para probar
  SELECT piso_stock_sector_grid(id)
  INTO v_result
  FROM public.piso_sectores
  LIMIT 1;

  IF v_result IS NOT NULL THEN
    v_count := jsonb_array_length(v_result);
    RAISE NOTICE '=== JHIA-62 VERIFICACION ===';
    RAISE NOTICE '  RPC retorno % posiciones con stock', v_count;

    -- Verificar que al menos una posicion tiene bloques_json no vacio
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_result) AS r
      WHERE jsonb_array_length(r->'bloques_json') > 0
    ) THEN
      RAISE NOTICE '  bloques_json: CON DATOS (correcto)';
    ELSE
      RAISE NOTICE '  bloques_json: TODOS VACIOS (revisar datos)';
    END IF;
  ELSE
    RAISE NOTICE '=== JHIA-62 VERIFICACION ===';
    RAISE NOTICE '  No hay sectores con datos para probar';
  END IF;
END $$;
