-- ═══════════════════════════════════════════════════════════════════════════════
-- RACKLY — PISO: Diagnostico y correccion del stock de salidas
-- Problema: Las salidas registradas con el RPC anterior no incluyen
--            fecha_vencimiento, por lo que el frontend no logra
--            emparejarlas con los ingresos y el stock nunca baja.
-- Ejecutar en Supabase Dashboard > SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECCION 1: DIAGNOSTICO
-- Consultas para entender el estado actual de los datos.
-- Descomentar y ejecutar cada SELECT segun se necesite.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1.1 ── Verificar si la columna fecha_vencimiento existe en piso_movimiento_detalles
/*
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name  = 'piso_movimiento_detalles'
  AND column_name = 'fecha_vencimiento';
-- Si devuelve filas → la columna ya existe.
-- Si no devuelve nada → ejecutar SECCION 2 primero.
*/

-- 1.2 ── Ultimos 20 detalles de movimiento con tipo y fecha_vencimiento
--     (cualquier posicion, para ver el patron del bug)
/*
SELECT
  m.tipo,
  m.fecha                    AS fecha_movimiento,
  d.bloque_id,
  b.codigo                   AS bloque_codigo,
  b.descripcion              AS bloque_descripcion,
  d.cantidad,
  d.fecha_vencimiento,
  n.codigo_ubicacion,
  m.usuario_nombre
FROM public.piso_movimiento_detalles d
JOIN public.piso_movimientos m ON m.id = d.movimiento_id
JOIN public.piso_bloques b    ON b.id = d.bloque_id
JOIN public.piso_niveles n    ON n.id = d.nivel_id
ORDER BY m.fecha DESC
LIMIT 20;
*/

-- 1.3 ── Conteo de detalles CON y SIN fecha_vencimiento
/*
SELECT
  CASE WHEN d.fecha_vencimiento IS NULL
       THEN 'SIN fecha_vencimiento'
       ELSE 'CON fecha_vencimiento'
  END                           AS grupo,
  COUNT(*)                      AS cantidad_detalles,
  m.tipo                        AS tipo_movimiento,
  SUM(d.cantidad)               AS total_cantidad
FROM public.piso_movimiento_detalles d
JOIN public.piso_movimientos m  ON m.id = d.movimiento_id
GROUP BY grupo, m.tipo
ORDER BY grupo, m.tipo;
*/

-- 1.4 ── Detalles huerfanos (sin movimiento padre)
/*
SELECT d.id, d.movimiento_id, d.bloque_id, d.cantidad
FROM public.piso_movimiento_detalles d
LEFT JOIN public.piso_movimientos m ON m.id = d.movimiento_id
WHERE m.id IS NULL;
-- Si devuelve filas → hay datos corruptos. No deberia ocurrir gracias a la FK.
*/

-- 1.5 ── Stock neto por bloque_id (ingreso vs salida)
--     Muestra el desbalance que genera el bug
/*
SELECT
  b.codigo                                AS bloque_codigo,
  b.descripcion                           AS bloque_descripcion,
  COALESCE(SUM(
    CASE WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
         THEN d.cantidad
         WHEN m.tipo = 'salida'
         THEN -d.cantidad
         ELSE 0
    END
  ), 0)                                   AS stock_neto_total,
  COALESCE(SUM(
    CASE WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
              AND d.fecha_vencimiento IS NOT NULL
         THEN d.cantidad
         ELSE 0
    END
  ), 0)                                   AS ingreso_con_fecha,
  COALESCE(SUM(
    CASE WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
              AND d.fecha_vencimiento IS NULL
         THEN d.cantidad
         ELSE 0
    END
  ), 0)                                   AS ingreso_sin_fecha,
  COALESCE(SUM(
    CASE WHEN m.tipo = 'salida'
              AND d.fecha_vencimiento IS NOT NULL
         THEN d.cantidad
         ELSE 0
    END
  ), 0)                                   AS salida_con_fecha,
  COALESCE(SUM(
    CASE WHEN m.tipo = 'salida'
              AND d.fecha_vencimiento IS NULL
         THEN d.cantidad
         ELSE 0
    END
  ), 0)                                   AS salida_sin_fecha
FROM public.piso_movimiento_detalles d
JOIN public.piso_movimientos m  ON m.id = d.movimiento_id
JOIN public.piso_bloques b     ON b.id = d.bloque_id
GROUP BY b.codigo, b.descripcion
HAVING COALESCE(SUM(
    CASE WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
         THEN d.cantidad
         WHEN m.tipo = 'salida'
         THEN -d.cantidad
         ELSE 0
    END
  ), 0) != 0
ORDER BY stock_neto_total DESC;
-- Si 'ingreso_con_fecha' > 0 y 'salida_sin_fecha' > 0 para el mismo bloque,
-- confirma el bug: las salidas no se emparejan con los ingresos.
*/


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECCION 2: FIX — Garantizar que el esquema es correcto
-- ═══════════════════════════════════════════════════════════════════════════════

-- 2.1 ── Asegurar que la columna fecha_vencimiento existe (idempotente)
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
    RAISE NOTICE 'Columna fecha_vencimiento creada exitosamente.';
  ELSE
    RAISE NOTICE 'Columna fecha_vencimiento ya existe. Ok.';
  END IF;
END $$;

-- 2.2 ── Comentario descriptivo en la columna
COMMENT ON COLUMN public.piso_movimiento_detalles.fecha_vencimiento
  IS 'Fecha de vencimiento del producto. NULL = sin fecha de vencimiento registrada.';

-- 2.3 ── Indice parcial para optimizar consultas de stock (ignora NULLs)
CREATE INDEX IF NOT EXISTS
  idx_piso_mov_detalles_fecha_venc
  ON public.piso_movimiento_detalles (fecha_vencimiento)
  WHERE fecha_vencimiento IS NOT NULL;

-- 2.4 ── Indice compuesto para las consultas de stock por posicion
CREATE INDEX IF NOT EXISTS
  idx_piso_mov_detalles_nivel_bloque
  ON public.piso_movimiento_detalles (nivel_id, bloque_id);


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECCION 3: FIX — RPC piso_stock_detalle_posicion
-- Calcula el stock real por bloque en una posicion usando FEFO.
-- FEFO = First Expired, First Out (lo que vence primero, sale primero).
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
  -- ── Paso 1: Obtener todos los niveles de la posicion ──
  SELECT ARRAY_AGG(n.id) INTO v_nivel_ids
  FROM public.piso_niveles n
  WHERE n.posicion_id = _posicion_id;

  IF v_nivel_ids IS NULL OR array_length(v_nivel_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- ── Paso 2: Recorrer cada bloque con movimientos en estos niveles ──
  FOR v_bloque_rec IN
    SELECT DISTINCT d.bloque_id
    FROM public.piso_movimiento_detalles d
    WHERE d.nivel_id = ANY(v_nivel_ids)
  LOOP
    -- ── 2a: Total de salidas para este bloque ──
    SELECT COALESCE(SUM(d.cantidad), 0)
    INTO v_total_salida
    FROM public.piso_movimiento_detalles d
    JOIN public.piso_movimientos m ON m.id = d.movimiento_id
    WHERE d.bloque_id = v_bloque_rec.bloque_id
      AND d.nivel_id  = ANY(v_nivel_ids)
      AND m.tipo      = 'salida';

    -- ── 2b: Info del bloque (codigo, descripcion, unidad) ──
    SELECT b.codigo, b.descripcion, b.unidad
    INTO v_bloque_info
    FROM public.piso_bloques b
    WHERE b.id = v_bloque_rec.bloque_id;

    IF v_bloque_info IS NULL THEN
      CONTINUE;
    END IF;

    -- ── 2c: Recorrer lotes de ingreso en orden FEFO ──
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
        -- Sin salidas pendientes → retornar lote completo
        bloque_id          := v_bloque_rec.bloque_id;
        bloque_codigo      := v_bloque_info.codigo;
        bloque_descripcion := v_bloque_info.descripcion;
        bloque_unidad      := v_bloque_info.unidad;
        cantidad           := v_lot.ingreso_qty;
        fecha_vencimiento  := COALESCE(v_lot.fecha_vencimiento::TEXT, '');
        RETURN NEXT;

      ELSIF v_lot.ingreso_qty <= v_pendiente THEN
        -- Lote consumido completamente
        v_pendiente := v_pendiente - v_lot.ingreso_qty;

      ELSE
        -- Consumo parcial → retornar sobrante
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

-- Comentario de la funcion
COMMENT ON FUNCTION public.piso_stock_detalle_posicion(UUID) IS
  'Calcula el stock por bloque en una posicion usando algoritmo FEFO. '
  'Descontara TODAS las salidas (sin importar fecha_vencimiento) de los '
  'lotes de ingreso ordenados por vencimiento (los que vencen primero salen primero).';


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECCION 4: FIX — RPC piso_stock_sector_grid
-- Devuelve una grilla con el stock total por posicion dentro de un sector.
-- Calcula stock neto por bloque_id (ignorando fecha_vencimiento para el total).
-- ═══════════════════════════════════════════════════════════════════════════════

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
  -- ── Recorrer cada posicion del sector ──
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
    -- ── Calcular stock total neto de la posicion ──
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

    -- Solo incluir posiciones con stock > 0
    IF v_stock_total > 0 THEN
      -- ── Construir JSON con detalle por bloque ──
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

      -- Retornar fila
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
  'Retorna una grilla de posiciones con stock > 0 para un sector dado. '
  'Incluye el stock total neto y un JSON con el detalle por bloque.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECCION 5: FIX — Actualizar piso_registrar_movimiento
-- Ahora soporta fecha_vencimiento en el JSONB de detalles.
-- Se extrae del campo "fecha_vencimiento" de cada objeto en el array.
-- ═══════════════════════════════════════════════════════════════════════════════

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
  -- ── Crear cabecera del movimiento ──
  INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo)
  VALUES (
    _tipo,
    _turno,
    NULL,
    NULL,
    NULL
  )
  RETURNING id INTO v_mov_id;

  -- ── Crear cada detalle (ahora incluye fecha_vencimiento) ──
  FOR v_det IN SELECT * FROM jsonb_array_elements(_detalles)
  LOOP
    -- Extraer fecha_vencimiento del JSON (puede ser null, vacio o una fecha ISO)
    v_fv := v_det->>'fecha_vencimiento';

    IF v_fv IS NOT NULL AND v_fv != '' AND v_fv != 'null' THEN
      BEGIN
        v_fv_date := to_date(v_fv, 'YYYY-MM-DD');
      EXCEPTION WHEN OTHERS THEN
        -- Si el formato no es valido, intentar con timestamp
        v_fv_date := (v_fv::TIMESTAMPTZ)::DATE;
      END;
    ELSE
      v_fv_date := NULL;
    END IF;

    INSERT INTO public.piso_movimiento_detalles (
      movimiento_id,
      nivel_id,
      bloque_id,
      cantidad,
      fecha_vencimiento
    )
    VALUES (
      v_mov_id,
      (v_det->>'nivel_id')::UUID,
      (v_det->>'bloque_id')::UUID,
      COALESCE((v_det->>'cantidad')::NUMERIC, 0),
      v_fv_date
    );
  END LOOP;

  -- ── Retornar el movimiento creado ──
  RETURN QUERY
    SELECT *
    FROM public.piso_movimientos
    WHERE id = v_mov_id;
END;
$$;

COMMENT ON FUNCTION public.piso_registrar_movimiento(TEXT, TEXT, JSONB) IS
  'Registra un movimiento (ingreso/salida/stock_inicial) con sus detalles. '
  'Cada detalle puede incluir fecha_vencimiento en formato YYYY-MM-DD. '
  'Ejemplo de _detalles: [{"nivel_id":"...","bloque_id":"...","cantidad":10,"fecha_vencimiento":"2025-12-31"}]';


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECCION 6: FIX — Backfill de fecha_vencimiento para detalles existentes
-- Estrategia: Copiar la fecha_vencimiento del INGRESO mas antiguo
--             que tenga fecha para el mismo bloque_id + nivel_id.
-- Solo actualiza detalles de SALIDA que tengan fecha_vencimiento = NULL.
-- Es "mejor esfuerzo": no todos los registros podran obtener fecha.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 6.1 ── Vista previa: cuantos registros se verian afectados
/*
SELECT
  COUNT(*) AS salidas_sin_fecha_a_backfill
FROM public.piso_movimiento_detalles d
JOIN public.piso_movimientos m ON m.id = d.movimiento_id
WHERE m.tipo = 'salida'
  AND d.fecha_vencimiento IS NULL
  AND EXISTS (
    SELECT 1 FROM public.piso_movimiento_detalles d2
    JOIN public.piso_movimientos m2 ON m2.id = d2.movimiento_id
    WHERE d2.bloque_id = d.bloque_id
      AND d2.nivel_id  = d.nivel_id
      AND m2.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
      AND d2.fecha_vencimiento IS NOT NULL
  );
*/

-- 6.2 ── Ejecutar el backfill (descomentar para ejecutar)
/*
UPDATE public.piso_movimiento_detalles d_salida
SET fecha_vencimiento = sub.earliest_fecha
FROM (
  SELECT DISTINCT
    d_s.id AS detalle_id,
    (
      SELECT MIN(d_i.fecha_vencimiento)
      FROM public.piso_movimiento_detalles d_i
      JOIN public.piso_movimientos m_i ON m_i.id = d_i.movimiento_id
      WHERE d_i.bloque_id = d_s.bloque_id
        AND d_i.nivel_id  = d_s.nivel_id
        AND m_i.tipo IN ('ingreso', 'stock_inicial', 'devolucion')
        AND d_i.fecha_vencimiento IS NOT NULL
    ) AS earliest_fecha
  FROM public.piso_movimiento_detalles d_s
  JOIN public.piso_movimientos m_s ON m_s.id = d_s.movimiento_id
  WHERE m_s.tipo = 'salida'
    AND d_s.fecha_vencimiento IS NULL
) sub
WHERE d_salida.id = sub.detalle_id
  AND sub.earliest_fecha IS NOT NULL;
*/

-- 6.3 ── Verificacion post-backfill: confirmar cuantas salidas siguen sin fecha
/*
SELECT
  COUNT(*) AS salidas_sin_fecha_restantes
FROM public.piso_movimiento_detalles d
JOIN public.piso_movimientos m ON m.id = d.movimiento_id
WHERE m.tipo = 'salida'
  AND d.fecha_vencimiento IS NULL;
*/

-- ═══════════════════════════════════════════════════════════════════════════════
-- RESUMEN DE CAMBIOS
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- SECCION 1: Consultas de diagnostico (ejecutar individualmente)
--   → Permiten ver el estado actual del bug
--
-- SECCION 2: Correccion de esquema
--   → Garantiza que fecha_vencimiento existe
--   → Crea indices para rendimiento
--
-- SECCION 3: Nueva RPC piso_stock_detalle_posicion(_posicion_id)
--   → Calcula stock REAL por bloque usando FEFO
--   → Descontara TODAS las salidas sin importar fecha_vencimiento
--   → Retorna lotes restantes con cantidad > 0
--   → EL FRONTEND DEBE USAR ESTA RPC en vez de calcular en el cliente
--
-- SECCION 4: Nueva RPC piso_stock_sector_grid(_sector_id)
--   → Grilla de posiciones con stock > 0 para un sector
--   → Incluye detalle por bloque en formato JSONB
--
-- SECCION 5: RPC piso_registrar_movimiento actualizada
--   → Ahora acepta fecha_vencimiento en el JSONB de detalles
--   → Nuevas salidas tendran fecha_vencimiento si el frontend la envia
--
-- SECCION 6: Backfill de datos existentes (ejecutar manualmente)
--   → Copia la fecha del ingreso mas antiguo a salidas sin fecha
--   → Es "mejor esfuerzo" - algunas salidas podrian quedar sin fecha
--   → Descomentar los bloques y ejecutar en orden: 6.1 → 6.2 → 6.3
--
-- NOTA IMPORTANTE:
--   El backend ahora maneja la logica FEFO correctamente.
--   Sin embargo, si el frontend sigue calculando stock agrupando por
--   'bloque_id::fecha_vencimiento' en el cliente, el bug persistira.
--   El frontend debe consumir piso_stock_detalle_posicion() directamente
--   y usar sus resultados como fuente de verdad del stock.
-- ═══════════════════════════════════════════════════════════════════════════════
