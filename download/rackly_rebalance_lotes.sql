-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY · rackly_rebalance_lotes.sql
-- FASE 3 de la reparación de "negativos por lote": rebalanceo ENTRE lotes.
--
-- PROBLEMA RESIDUAL (tras backfill fases 1-2):
--   32 celdas (ubic+código+lote FÍSICO) con neto negativo donde la celda
--   completa (ubic+código) es POSITIVA: salidas registradas con un lote
--   específico excedieron el saldo de ese lote, mientras otros lotes de la
--   misma celda (o el bucket "sin lote") conservan superávit. Artefacto de
--   atribución entre lotes: el stock del usuario es correcto, la distribución
--   por lote no.
--
-- SOLUCIÓN:
--   Re-atribuir salidas de un lote negativo hacia otros buckets de la MISMA
--   celda con superávit (lotes físicos y bucket "sin lote"), orden FEFO
--   (vencimiento más próximo primero, empate: ingreso más antiguo), por
--   cuotas (la fila original toma la primera; copias con uuid_sync=NULL).
--
-- GARANTÍAS:
--   · Solo celdas con neto total >= 0 (déficits reales intocables).
--   · Solo filas tipo='salida', codigo_inc IS NULL, con lote asignado.
--   · Cada cuota <= saldo actual del bucket receptor (nunca lo deja < 0).
--   · No cambia cantidades totales por celda (conservación).
--   · Idempotente: al converger devuelve contadores en 0.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rackly_rebalance_lotes_fefo()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r_sal RECORD;
  r_lote RECORD;
  v_saldo_obj NUMERIC;
  v_cuota NUMERIC;
  v_reasignadas INT := 0;
  v_copias INT := 0;
  v_asignadas_iter INT := 0;
  v_iter INT := 0;
  v_sigue BOOL := TRUE;
BEGIN
  WHILE v_sigue AND v_iter < 50 LOOP
    v_iter := v_iter + 1;
    v_sigue := FALSE;
    v_asignadas_iter := 0;

    FOR r_sal IN
      WITH netos AS (
        -- saldo de CADA bucket (ubic+cód+lote) de la celda
        SELECT bloque,
               TRIM(LEADING '0' FROM torre)    AS tn,
               TRIM(LEADING '0' FROM piso)     AS pn,
               TRIM(LEADING '0' FROM posicion) AS posn,
               UPPER(TRIM(codigo))             AS cod,
               COALESCE(NULLIF(TRIM(lote), ''), '(sl)') AS lote_n,
               SUM(CASE WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
                        WHEN tipo = 'salida' THEN -cantidad ELSE 0 END) AS neto
        FROM movimientos
        WHERE codigo_inc IS NULL
        GROUP BY 1,2,3,4,5,6
      ),
      celdas AS (
        -- celdas con bucket negativo y neto total >= 0 (reparables)
        SELECT bloque, tn, pn, posn, cod
        FROM netos
        GROUP BY 1,2,3,4,5
        HAVING SUM(neto) >= 0
           AND BOOL_AND(neto >= 0) = FALSE
      )
      -- salidas CON lote cuyo bucket individual es negativo en celda reparable
      SELECT m.id, m.bloque, m.torre, m.piso, m.posicion, m.codigo, m.cantidad,
             m.lote AS lote_origen,
             m.descripcion, m.un, m.f_vencimiento, m.turno, m.usuario_id,
             m.usuario_nombre, m.usuario_correo, m.proveedor, m.uuid_sync
      FROM movimientos m
      JOIN netos nb
        ON nb.bloque = m.bloque
       AND nb.tn = TRIM(LEADING '0' FROM m.torre)
       AND nb.pn = TRIM(LEADING '0' FROM m.piso)
       AND nb.posn = TRIM(LEADING '0' FROM m.posicion)
       AND nb.cod = UPPER(TRIM(m.codigo))
       AND nb.lote_n = COALESCE(NULLIF(TRIM(m.lote), ''), '(sl)')
      JOIN celdas c
        ON c.bloque = m.bloque AND c.tn = nb.tn AND c.pn = nb.pn
       AND c.posn = nb.posn AND c.cod = nb.cod
      WHERE m.tipo = 'salida'
        AND m.codigo_inc IS NULL
        AND COALESCE(TRIM(m.lote), '') <> ''
        AND nb.neto < 0
      ORDER BY m.f_modificacion ASC
      LIMIT 20000
    LOOP
      -- verificar que su bucket de origen SIGUE negativo (lectura fresca)
      IF (
        SELECT COALESCE(SUM(
          CASE WHEN x.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN x.cantidad
               WHEN x.tipo = 'salida' THEN -x.cantidad ELSE 0 END), 0)
        FROM movimientos x
        WHERE x.codigo_inc IS NULL
          AND COALESCE(NULLIF(TRIM(x.lote), ''), '(sl)')
              = COALESCE(NULLIF(TRIM(r_sal.lote_origen), ''), '(sl)')
          AND x.bloque = r_sal.bloque
          AND TRIM(LEADING '0' FROM x.torre)    = TRIM(LEADING '0' FROM r_sal.torre)
          AND TRIM(LEADING '0' FROM x.piso)     = TRIM(LEADING '0' FROM r_sal.piso)
          AND TRIM(LEADING '0' FROM x.posicion) = TRIM(LEADING '0' FROM r_sal.posicion)
          AND UPPER(TRIM(x.codigo)) = UPPER(TRIM(r_sal.codigo))
      ) >= 0 THEN
        CONTINUE;  -- ya no es negativo: nada que hacer
      END IF;

      DECLARE
        v_pendiente NUMERIC := r_sal.cantidad;
        v_tomo_original BOOL := FALSE;
      BEGIN
        -- buckets receptores de la MISMA celda con superávit, orden FEFO
        FOR r_lote IN
          SELECT c2.lote_n
          FROM (
            SELECT COALESCE(NULLIF(TRIM(m2.lote), ''), '(sl)') AS lote_n,
                   MIN(m2.f_vencimiento) AS min_venc,
                   MIN(m2.f_modificacion) AS primer_ing
            FROM movimientos m2
            WHERE m2.bloque = r_sal.bloque
              AND TRIM(LEADING '0' FROM m2.torre)    = TRIM(LEADING '0' FROM r_sal.torre)
              AND TRIM(LEADING '0' FROM m2.piso)     = TRIM(LEADING '0' FROM r_sal.piso)
              AND TRIM(LEADING '0' FROM m2.posicion) = TRIM(LEADING '0' FROM r_sal.posicion)
              AND UPPER(TRIM(m2.codigo)) = UPPER(TRIM(r_sal.codigo))
              AND m2.codigo_inc IS NULL
              -- solo el POOL normal: receptores = lotes físicos y bucket "sl"
            GROUP BY 1
          ) c2
          WHERE (
            -- saldo ACTUAL del bucket receptor (fresco) > 0
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
              AND COALESCE(NULLIF(TRIM(m3.lote), ''), '(sl)') = c2.lote_n
          ) > 0
          ORDER BY c2.min_venc ASC NULLS LAST, c2.primer_ing ASC
        LOOP
          EXIT WHEN v_pendiente <= 0;

          -- saldo fresco del receptor (excluye la propia fila en tránsito)
          SELECT COALESCE(SUM(
            CASE WHEN m3.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m3.cantidad
                 WHEN m3.tipo = 'salida' THEN -m3.cantidad ELSE 0 END), 0)
            INTO v_saldo_obj
          FROM movimientos m3
          WHERE m3.bloque = r_sal.bloque
            AND TRIM(LEADING '0' FROM m3.torre)    = TRIM(LEADING '0' FROM r_sal.torre)
            AND TRIM(LEADING '0' FROM m3.piso)     = TRIM(LEADING '0' FROM r_sal.piso)
            AND TRIM(LEADING '0' FROM m3.posicion) = TRIM(LEADING '0' FROM r_sal.posicion)
            AND UPPER(TRIM(m3.codigo)) = UPPER(TRIM(r_sal.codigo))
            AND m3.codigo_inc IS NULL
            AND COALESCE(NULLIF(TRIM(m3.lote), ''), '(sl)') = r_lote.lote_n;

          EXIT WHEN v_saldo_obj <= 0;

          v_cuota := LEAST(v_saldo_obj, v_pendiente);
          -- lote receptor ('(sl)' → NULL)
          DECLARE
            v_lote_dest TEXT := NULLIF(r_lote.lote_n, '(sl)');
          BEGIN
            IF NOT v_tomo_original THEN
              UPDATE movimientos
                 SET lote = v_lote_dest, cantidad = v_cuota
               WHERE id = r_sal.id;
              v_tomo_original := TRUE;
            ELSE
              INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo,
                descripcion, un, cantidad, f_vencimiento, turno, usuario_id,
                usuario_nombre, usuario_correo, proveedor, uuid_sync, codigo_inc, lote)
              VALUES ('salida', r_sal.bloque, r_sal.torre, r_sal.piso, r_sal.posicion,
                r_sal.codigo, r_sal.descripcion, r_sal.un, v_cuota,
                r_sal.f_vencimiento, r_sal.turno, r_sal.usuario_id,
                r_sal.usuario_nombre, r_sal.usuario_correo, r_sal.proveedor,
                NULL, NULL, v_lote_dest);
              v_copias := v_copias + 1;
            END IF;
          END;

          v_pendiente := v_pendiente - v_cuota;
          v_reasignadas := v_reasignadas + 1;
          v_asignadas_iter := v_asignadas_iter + 1;
        END LOOP;

        -- remanente: devolverlo al lote de ORIGEN como fila residual
        IF v_tomo_original AND v_pendiente > 0 THEN
          INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo,
            descripcion, un, cantidad, f_vencimiento, turno, usuario_id,
            usuario_nombre, usuario_correo, proveedor, uuid_sync, codigo_inc, lote)
          VALUES ('salida', r_sal.bloque, r_sal.torre, r_sal.piso, r_sal.posicion,
            r_sal.codigo, r_sal.descripcion, r_sal.un, v_pendiente,
            r_sal.f_vencimiento, r_sal.turno, r_sal.usuario_id,
            r_sal.usuario_nombre, r_sal.usuario_correo, r_sal.proveedor,
            NULL, NULL, r_sal.lote_origen);
        END IF;
        -- si no tomó nada: fila intacta (se reintenta en la siguiente iteración)
      END;

      IF v_asignadas_iter > 0 THEN
        v_sigue := TRUE;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'fase3_cuotas_reasignadas', v_reasignadas,
    'fase3_copias_insertadas',  v_copias,
    'iteraciones',              v_iter
  );
END;
$$;

-- ── Ejecutar ────────────────────────────────────────────────────────────────
SELECT public.rackly_rebalance_lotes_fefo();

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
