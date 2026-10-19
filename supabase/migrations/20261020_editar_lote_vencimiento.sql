-- ═══════════════════════════════════════════════════════════════════
-- RACKLY — Editar LOTE y F. VENCIMIENTO de artículos SIN esos datos
-- (pedido del usuario 2026-10-20, módulos Racks y Piso)
--
-- PROBLEMA: los artículos ingresados sin lote y sin fecha de vencimiento
-- quedaban "congelados": no había forma de completar esos datos después,
-- y Tránsito NO los deja transferir (regla "sin lote o sin vencimiento no
-- es transferible"). El almacenero no podía corregir el registro.
--
-- SOLUCIÓN: retro-etiquetado CONSISTENTE del bucket "sin lote / sin fecha".
--   · Solo se tocan filas con lote VACÍO **y** f_vencimiento NULL
--     (exactamente el alcance pedido: artículos sin fechas y sin lote).
--   · Se re-etiquetan TODAS esas filas de la ubicación (entradas Y salidas
--     históricas): el saldo del bucket se conserva exacto — la suma por
--     lote no cambia, solo el nombre del bucket. Imposible fabricar
--     negativos (misma operación que renombrar una carpeta).
--   · cantidad NUNCA se modifica → stock global idéntico antes y después.
--   · INC excluido (codigo_inc IS NULL): los INC tienen su propio flujo
--     de revalidación de Calidad.
--   · f_modificacion NO se toca: el FEFO usa MIN(f_modificacion) como
--     desempate de ingreso antiguo; alterarla cambiaría el orden.
--   · Advisory lock con la MISMA llave que registrar_movimiento_kardex:
--     ninguna salida concurrente puede intercalarse a mitad del cambio.
--
-- El resultado es directamente consumible por todo el pipeline existente:
-- FEFO (Racks y Piso), Ocupación, y la regla de transferencia de Tránsito
-- (el artículo pasa a ser transferible al tener lote/fecha).
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────── RACKS (Kardex) ───────────────────────────
CREATE OR REPLACE FUNCTION public.editar_lote_vencimiento_racks(
  p_bloque text,
  p_torre text,
  p_piso text,
  p_posicion text,
  p_codigo text,
  p_lote text DEFAULT NULL,
  p_f_vencimiento text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_codigo TEXT;
  v_lote   TEXT;
  v_fven   DATE;
  v_rows   INT;
  v_loc_key TEXT;
BEGIN
  v_codigo := UPPER(TRIM(p_codigo));
  v_lote   := NULLIF(TRIM(p_lote), '');
  v_fven   := NULLIF(TRIM(p_f_vencimiento), '')::date;

  IF v_codigo IS NULL OR v_codigo = '' THEN
    RAISE EXCEPTION 'SIN_DATOS|Código de artículo vacío';
  END IF;
  IF v_lote IS NULL AND v_fven IS NULL THEN
    RAISE EXCEPTION 'SIN_DATOS|Indique el lote y/o la fecha de vencimiento del producto';
  END IF;

  -- Anti-carrera: misma llave que registrar_movimiento_kardex (bloque/torre/
  -- piso/posicion/código) para que ninguna salida se intercale durante el cambio.
  v_loc_key := p_bloque || '/' || p_torre || '/' || p_piso || '/' || p_posicion || '/' || v_codigo;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_loc_key, 0));

  UPDATE movimientos
  SET lote = v_lote,
      f_vencimiento = v_fven
  WHERE bloque = p_bloque
    AND TRIM(LEADING '0' FROM torre)    = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
    AND TRIM(LEADING '0' FROM piso)     = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
    AND TRIM(LEADING '0' FROM posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
    AND codigo = v_codigo
    AND codigo_inc IS NULL
    AND COALESCE(TRIM(lote), '') = ''
    AND f_vencimiento IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'SIN_FILAS|No hay stock sin lote y sin fecha para % en esa ubicación (puede que ya tenga datos)', v_codigo;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'filas_actualizadas', v_rows,
    'lote', v_lote,
    'f_vencimiento', v_fven
  );
END;
$function$;

-- ─────────────────────────────── PISO ───────────────────────────────
-- El stock de Piso vive en piso_movimiento_detalles (por nivel de la
-- posición). El botón "Editar" envía posicion_id + bloque_id (el bloque
-- de Piso ES el artículo): se actualizan los detalles vacíos de ese
-- artículo en TODOS los niveles de la posición — mismo criterio de
-- retro-etiquetado consistente que en Racks.
CREATE OR REPLACE FUNCTION public.editar_lote_vencimiento_piso(
  p_posicion_id uuid,
  p_bloque_id uuid,
  p_lote text DEFAULT NULL,
  p_f_vencimiento text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lote TEXT;
  v_fven DATE;
  v_rows INT;
  v_lock TEXT;
BEGIN
  v_lote := NULLIF(TRIM(p_lote), '');
  v_fven := NULLIF(TRIM(p_f_vencimiento), '')::date;

  IF v_lote IS NULL AND v_fven IS NULL THEN
    RAISE EXCEPTION 'SIN_DATOS|Indique el lote y/o la fecha de vencimiento del producto';
  END IF;

  -- Anti-carrera por posición+artículo
  v_lock := p_posicion_id::text || '/' || p_bloque_id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lock, 0));

  UPDATE piso_movimiento_detalles d
  SET lote = v_lote,
      fecha_vencimiento = v_fven
  FROM piso_niveles n
  WHERE d.nivel_id = n.id
    AND n.posicion_id = p_posicion_id
    AND d.bloque_id = p_bloque_id
    AND COALESCE(TRIM(d.lote), '') = ''
    AND d.fecha_vencimiento IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'SIN_FILAS|No hay stock sin lote y sin fecha para este artículo en esa posición (puede que ya tenga datos)';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'filas_actualizadas', v_rows,
    'lote', v_lote,
    'f_vencimiento', v_fven
  );
END;
$function$;
