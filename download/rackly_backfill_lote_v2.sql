-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY · rackly_backfill_lote_v2.sql
-- Reparación del histórico restante de "negativos por lote" (los 719/740/88).
--
-- CONTEXTO (16-oct-2026):
--   Tras el deploy de las RPCs v4 (auto-lote FEFO en salidas sin lote) quedan
--   88 celdas (ubic+código+lote) con neto negativo: artefactos de atribución
--   de salidas históricas registradas sin lote. El backfill anterior alcanzó
--   91%; este script completa la reparación y es IDEMPOTENTE.
--
-- ESTRATEGIA (2 fases — solo re-atribución; el neto por ubicación NO cambia):
--   FASE 1 · Re-asignar cada salida sin lote a UN lote físico cuyo saldo por
--            lote cubra TODA la cantidad (FEFO: vencimiento próximo primero,
--            empate: ingreso más antiguo). Solo si su bucket "sin lote" está
--            en negativo. Itera hasta estabilizar.
--   FASE 2 · Dividir salidas sin lote restantes en cuotas por lote (FEFO),
--            cuando ningún lote cubre la salida completa. La fila original
--            toma la primera cuota; las demás se insertan como copias con
--            metadata idéntica y uuid_sync=NULL (índice único).
--
-- GARANTÍAS DE SEGURIDAD:
--   · Solo toca filas: tipo='salida', codigo_inc IS NULL, lote vacío.
--   · Nunca deja un lote receptor en negativo (saldo restante >= cuota).
--   · No cambia cantidades totales, tipos, ubicaciones, usuarios ni fechas.
--   · Déficits reales (sin lotes con saldo que absorban) quedan intactos.
--   · Re-ejecutable: al converger, no hace nada (idempotente).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rackly_backfill_lote_fefo()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r_sal RECORD;
  r_lote RECORD;
  v_elegido TEXT;
  v_saldo_lote NUMERIC;
  v_reparadas1 INT := 0;
  v_reparadas2 INT := 0;
  v_filas_divididas INT := 0;
  v_iter INT := 0;
  v_sigue BOOL := TRUE;
BEGIN
  -- ════════════════════════════════════════════════════════════════════
  -- FASE 1 · asignación a lote cubriente (iterar hasta estabilizar)
  -- ════════════════════════════════════════════════════════════════════
  WHILE v_sigue AND v_iter < 50 LOOP
    v_iter := v_iter + 1;
    v_sigue := FALSE;

    FOR r_sal IN
      -- pre-filtro rápido por CTE (buckets "sin lote" negativos) + verificación
      -- por fila con lectura fresca (los saldos cambian durante el bucle)
      WITH neg_buckets AS (
        SELECT bloque,
               TRIM(LEADING '0' FROM torre)    AS tn,
               TRIM(LEADING '0' FROM piso)     AS pn,
               TRIM(LEADING '0' FROM posicion) AS posn,
               UPPER(TRIM(codigo))             AS cod
        FROM movimientos
        WHERE codigo_inc IS NULL AND COALESCE(TRIM(lote), '') = ''
        GROUP BY 1,2,3,4,5
        HAVING SUM(CASE WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
                        WHEN tipo = 'salida' THEN -cantidad ELSE 0 END) < 0
      )
      SELECT m.id, m.bloque, m.torre, m.piso, m.posicion, m.codigo, m.cantidad
      FROM movimientos m
      JOIN neg_buckets b
        ON m.bloque = b.bloque
       AND TRIM(LEADING '0' FROM m.torre)    = b.tn
       AND TRIM(LEADING '0' FROM m.piso)     = b.pn
       AND TRIM(LEADING '0' FROM m.posicion) = b.posn
       AND UPPER(TRIM(m.codigo)) = b.cod
      WHERE m.tipo = 'salida'
        AND m.codigo_inc IS NULL
        AND COALESCE(TRIM(m.lote), '') = ''
        -- verificación fresca: el bucket sigue en negativo ahora mismo
        AND (
          SELECT COALESCE(SUM(
            CASE WHEN x.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN x.cantidad
                 WHEN x.tipo = 'salida' THEN -x.cantidad ELSE 0 END), 0)
          FROM movimientos x
          WHERE x.codigo_inc IS NULL
            AND COALESCE(TRIM(x.lote), '') = ''
            AND x.bloque = m.bloque
            AND TRIM(LEADING '0' FROM x.torre)    = TRIM(LEADING '0' FROM m.torre)
            AND TRIM(LEADING '0' FROM x.piso)     = TRIM(LEADING '0' FROM m.piso)
            AND TRIM(LEADING '0' FROM x.posicion) = TRIM(LEADING '0' FROM m.posicion)
            AND UPPER(TRIM(x.codigo)) = UPPER(TRIM(m.codigo))
        ) < 0
      ORDER BY m.f_modificacion ASC
      LIMIT 20000
    LOOP
      -- lote cubriente con saldo suficiente (FEFO: vencimiento, luego antigüedad)
      SELECT c.lote INTO v_elegido
      FROM (
        SELECT m2.lote AS lote,
               SUM(CASE WHEN m2.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m2.cantidad ELSE -m2.cantidad END) AS saldo_lote,
               MIN(m2.f_vencimiento) AS min_venc,
               MIN(m2.f_modificacion) AS primer_ing
        FROM movimientos m2
        WHERE m2.bloque = r_sal.bloque
          AND TRIM(LEADING '0' FROM m2.torre)    = TRIM(LEADING '0' FROM r_sal.torre)
          AND TRIM(LEADING '0' FROM m2.piso)     = TRIM(LEADING '0' FROM r_sal.piso)
          AND TRIM(LEADING '0' FROM m2.posicion) = TRIM(LEADING '0' FROM r_sal.posicion)
          AND UPPER(TRIM(m2.codigo)) = UPPER(TRIM(r_sal.codigo))
          AND m2.codigo_inc IS NULL
          AND COALESCE(TRIM(m2.lote), '') <> ''
        GROUP BY m2.lote
      ) c
      WHERE c.saldo_lote >= r_sal.cantidad
      ORDER BY c.min_venc ASC NULLS LAST, c.primer_ing ASC
      LIMIT 1;

      IF v_elegido IS NOT NULL THEN
        UPDATE movimientos SET lote = v_elegido WHERE id = r_sal.id;
        v_reparadas1 := v_reparadas1 + 1;
        v_sigue := TRUE;  -- los saldos cambiaron: re-evaluar
      END IF;
    END LOOP;
  END LOOP;

  -- ════════════════════════════════════════════════════════════════════
  -- FASE 2 · dividir salidas restantes entre lotes (FEFO, por cuotas)
  -- ════════════════════════════════════════════════════════════════════
  FOR r_sal IN
    WITH neg_buckets AS (
      SELECT bloque,
             TRIM(LEADING '0' FROM torre)    AS tn,
             TRIM(LEADING '0' FROM piso)     AS pn,
             TRIM(LEADING '0' FROM posicion) AS posn,
             UPPER(TRIM(codigo))             AS cod
      FROM movimientos
      WHERE codigo_inc IS NULL AND COALESCE(TRIM(lote), '') = ''
      GROUP BY 1,2,3,4,5
      HAVING SUM(CASE WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
                      WHEN tipo = 'salida' THEN -cantidad ELSE 0 END) < 0
    )
    SELECT m.id, m.bloque, m.torre, m.piso, m.posicion, m.codigo, m.cantidad,
           m.descripcion, m.un, m.f_vencimiento, m.turno, m.usuario_id,
           m.usuario_nombre, m.usuario_correo, m.proveedor, m.uuid_sync
    FROM movimientos m
    JOIN neg_buckets b
      ON m.bloque = b.bloque
     AND TRIM(LEADING '0' FROM m.torre)    = b.tn
     AND TRIM(LEADING '0' FROM m.piso)     = b.pn
     AND TRIM(LEADING '0' FROM m.posicion) = b.posn
     AND UPPER(TRIM(m.codigo)) = b.cod
    WHERE m.tipo = 'salida'
      AND m.codigo_inc IS NULL
      AND COALESCE(TRIM(m.lote), '') = ''
      -- bucket "sin lote" de su celda sigue en negativo (lectura fresca)
      AND (
        SELECT COALESCE(SUM(
          CASE WHEN x.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN x.cantidad
               WHEN x.tipo = 'salida' THEN -x.cantidad ELSE 0 END), 0)
        FROM movimientos x
        WHERE x.codigo_inc IS NULL
          AND COALESCE(TRIM(x.lote), '') = ''
          AND x.bloque = m.bloque
          AND TRIM(LEADING '0' FROM x.torre)    = TRIM(LEADING '0' FROM m.torre)
          AND TRIM(LEADING '0' FROM x.piso)     = TRIM(LEADING '0' FROM m.piso)
          AND TRIM(LEADING '0' FROM x.posicion) = TRIM(LEADING '0' FROM m.posicion)
          AND UPPER(TRIM(x.codigo)) = UPPER(TRIM(m.codigo))
      ) < 0
      -- y hay al menos un lote físico con saldo positivo
      AND EXISTS (
        SELECT 1 FROM movimientos y
        WHERE y.bloque = m.bloque
          AND TRIM(LEADING '0' FROM y.torre)    = TRIM(LEADING '0' FROM m.torre)
          AND TRIM(LEADING '0' FROM y.piso)     = TRIM(LEADING '0' FROM m.piso)
          AND TRIM(LEADING '0' FROM y.posicion) = TRIM(LEADING '0' FROM m.posicion)
          AND UPPER(TRIM(y.codigo)) = UPPER(TRIM(m.codigo))
          AND y.codigo_inc IS NULL
          AND COALESCE(TRIM(y.lote), '') <> ''
        GROUP BY y.lote
        HAVING SUM(CASE WHEN y.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN y.cantidad ELSE -y.cantidad END) > 0
      )
    ORDER BY m.f_modificacion ASC
    LIMIT 20000
  LOOP
    DECLARE
      v_pendiente NUMERIC := r_sal.cantidad;
      v_tomo_original BOOL := FALSE;
      v_cuota NUMERIC;
    BEGIN
      FOR r_lote IN
        SELECT c.lote
        FROM (
          SELECT m2.lote AS lote,
                 MIN(m2.f_vencimiento) AS min_venc,
                 MIN(m2.f_modificacion) AS primer_ing
          FROM movimientos m2
          WHERE m2.bloque = r_sal.bloque
            AND TRIM(LEADING '0' FROM m2.torre)    = TRIM(LEADING '0' FROM r_sal.torre)
            AND TRIM(LEADING '0' FROM m2.piso)     = TRIM(LEADING '0' FROM r_sal.piso)
            AND TRIM(LEADING '0' FROM m2.posicion) = TRIM(LEADING '0' FROM r_sal.posicion)
            AND UPPER(TRIM(m2.codigo)) = UPPER(TRIM(r_sal.codigo))
            AND m2.codigo_inc IS NULL
            AND COALESCE(TRIM(m2.lote), '') <> ''
          GROUP BY m2.lote
        ) c
        -- solo lotes con saldo positivo ACTUAL (recalculado abajo por cuota)
        WHERE (
          SELECT COALESCE(SUM(
            CASE WHEN m3.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m3.cantidad
                 WHEN m3.tipo = 'salida' THEN -m3.cantidad ELSE 0 END), 0)
          FROM movimientos m3
          WHERE m3.bloque = r_sal.bloque
            AND TRIM(LEADING '0' FROM m3.torre)    = TRIM(LEADING '0' FROM r_sal.torre)
            AND TRIM(LEADING '0' FROM m3.piso)     = TRIM(LEADING '0' FROM r_sal.piso)
            AND TRIM(LEADING '0' FROM m3.posicion) = TRIM(LEADING '0' FROM r_sal.posicion)
            AND UPPER(TRIM(m3.codigo)) = UPPER(TRIM(r_sal.codigo))
            AND m3.codigo_inc IS NULL
            AND m3.lote = c.lote
        ) > 0
        ORDER BY c.min_venc ASC NULLS LAST, c.primer_ing ASC
      LOOP
        EXIT WHEN v_pendiente <= 0;

        -- saldo ACTUAL del lote (cambia con cada cuota asignada)
        SELECT COALESCE(SUM(
          CASE WHEN m3.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m3.cantidad
               WHEN m3.tipo = 'salida' THEN -m3.cantidad ELSE 0 END), 0)
          INTO v_saldo_lote
        FROM movimientos m3
        WHERE m3.bloque = r_sal.bloque
          AND TRIM(LEADING '0' FROM m3.torre)    = TRIM(LEADING '0' FROM r_sal.torre)
          AND TRIM(LEADING '0' FROM m3.piso)     = TRIM(LEADING '0' FROM r_sal.piso)
          AND TRIM(LEADING '0' FROM m3.posicion) = TRIM(LEADING '0' FROM r_sal.posicion)
          AND UPPER(TRIM(m3.codigo)) = UPPER(TRIM(r_sal.codigo))
          AND m3.codigo_inc IS NULL
          AND m3.lote = r_lote.lote;

        EXIT WHEN v_saldo_lote <= 0;

        v_cuota := LEAST(v_saldo_lote, v_pendiente);

        IF NOT v_tomo_original THEN
          -- la fila original toma la primera cuota (lote + cantidad juntos)
          UPDATE movimientos
             SET lote = r_lote.lote, cantidad = v_cuota
           WHERE id = r_sal.id;
          v_tomo_original := TRUE;
        ELSE
          -- copia con metadata idéntica; uuid_sync=NULL evita índice único
          INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo,
            descripcion, un, cantidad, f_vencimiento, turno, usuario_id,
            usuario_nombre, usuario_correo, proveedor, uuid_sync, codigo_inc, lote)
          VALUES ('salida', r_sal.bloque, r_sal.torre, r_sal.piso, r_sal.posicion,
            r_sal.codigo, r_sal.descripcion, r_sal.un, v_cuota,
            r_sal.f_vencimiento, r_sal.turno, r_sal.usuario_id,
            r_sal.usuario_nombre, r_sal.usuario_correo, r_sal.proveedor,
            NULL, NULL, r_lote.lote);
          v_filas_divididas := v_filas_divididas + 1;
        END IF;

        v_pendiente := v_pendiente - v_cuota;
        v_reparadas2 := v_reparadas2 + 1;
      END LOOP;

      -- remanente sin lotes que lo absorban: devolverlo como fila sin lote
      IF v_tomo_original AND v_pendiente > 0 THEN
        INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo,
          descripcion, un, cantidad, f_vencimiento, turno, usuario_id,
          usuario_nombre, usuario_correo, proveedor, uuid_sync, codigo_inc, lote)
        VALUES ('salida', r_sal.bloque, r_sal.torre, r_sal.piso, r_sal.posicion,
          r_sal.codigo, r_sal.descripcion, r_sal.un, v_pendiente,
          r_sal.f_vencimiento, r_sal.turno, r_sal.usuario_id,
          r_sal.usuario_nombre, r_sal.usuario_correo, r_sal.proveedor,
          NULL, NULL, NULL);
      END IF;
      -- si no tomó nada (v_tomo_original = FALSE): fila intacta (déficit real)
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'fase1_filas_reasignadas', v_reparadas1,
    'fase2_cuotas_asignadas',  v_reparadas2,
    'fase2_filas_divididas',   v_filas_divididas
  );
END;
$$;

-- ── Ejecutar ────────────────────────────────────────────────────────────────
SELECT public.rackly_backfill_lote_fefo();

-- ── Verificación ────────────────────────────────────────────────────────────
WITH netos AS (
  SELECT bloque, torre, piso, posicion, UPPER(TRIM(codigo)) AS codigo,
         COALESCE(NULLIF(TRIM(lote),''),'(sin lote)') AS lote,
         SUM(CASE WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
                  WHEN tipo='salida' THEN -cantidad ELSE 0 END) AS neto
  FROM movimientos WHERE codigo_inc IS NULL
  GROUP BY 1,2,3,4,5,6
)
SELECT (SELECT count(*) FROM netos WHERE neto < 0) AS celdas_neg_restantes,
       (SELECT ROUND(SUM(neto)) FROM netos WHERE neto < 0) AS deficit_restante;
