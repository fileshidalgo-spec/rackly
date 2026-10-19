-- ═══════════════════════════════════════════════════════════════════
-- RACKLY — Editar LOTE y F. VENCIMIENTO de artículos (v2, 2026-10-20)
-- Ampliación del pedido del usuario (módulos Racks y Piso):
--   v1 (20261020_editar_lote_vencimiento.sql): COMPLETAR datos de
--      artículos registrados sin lote y sin fechas — cargo almacenero.
--   v2 (ESTA): CORREGIR también artículos que YA tienen lote/fechas
--      (alguien se equivocó al registrar) y ampliar los cargos.
--
-- CAMBIO CLAVE: nuevos parámetros p_lote_actual / p_f_vencimiento_actual.
--   · La UPDATE ahora apunta al bucket EXACTO que la UI muestra:
--       COALESCE(TRIM(lote),'') = COALESCE(v_lote_actual,'')
--       f_vencimiento IS NOT DISTINCT FROM v_fven_actual
--     (v1 era el caso particular lote_actual='' + fecha_actual=NULL).
--   · DEFAULT NULL en ambos → TODAS las llamadas v1 existentes siguen
--     funcionando byte-idéntico (retrocompatibilidad total).
--
-- INVARIANTES QUE SE CONSERVAN (idénticos a v1):
--   · cantidad NUNCA se modifica → stock global y saldo por lote quedan
--     EXACTOS; imposible fabricar negativos (es "renombrar una carpeta").
--   · Se re-etiquetan entradas Y salidas históricas del bucket: la
--     trazabilidad queda consistente con el saldo que se muestra.
--   · INC excluido (codigo_inc IS NULL): los INC tienen su propio flujo
--     de revalidación de Calidad.
--   · f_modificacion NO se toca: el FEFO usa MIN(f_modificacion) como
--     desempate de ingreso antiguo; alterarla cambiaría el orden.
--   · Advisory lock con la MISMA llave que registrar_movimiento_kardex
--     (Racks) / por posición+artículo (Piso): ninguna salida concurrente
--     puede intercalarse a mitad del cambio.
--
-- NOTA sobre roles: los cargos autorizados (almacenero, admin,
-- supervisor_almacen, supervisor_operaciones) se evalúan en el CLIENTE
-- (src/lib/rackly/lote.ts → puedeEditarLote) igual que en v1; las RPC
-- permanecen llamables por cualquier usuario autenticado del proyecto,
-- patrón idéntico al resto de RPCs de escritura de la app.
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────── RACKS (Kardex) ───────────────────────────
CREATE OR REPLACE FUNCTION public.editar_lote_vencimiento_racks(
  p_bloque text,
  p_torre text,
  p_piso text,
  p_posicion text,
  p_codigo text,
  p_lote text DEFAULT NULL,
  p_f_vencimiento text DEFAULT NULL,
  p_lote_actual text DEFAULT NULL,
  p_f_vencimiento_actual text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_codigo      TEXT;
  v_lote        TEXT;
  v_fven        DATE;
  v_lote_actual TEXT;
  v_fven_actual DATE;
  v_rows        INT;
  v_loc_key     TEXT;
BEGIN
  v_codigo := UPPER(TRIM(p_codigo));
  v_lote   := NULLIF(TRIM(p_lote), '');
  v_lote_actual := NULLIF(TRIM(p_lote_actual), '');

  -- Fechas con mensaje claro si el formato no es AAAA-MM-DD
  IF p_f_vencimiento IS NOT NULL AND TRIM(p_f_vencimiento) <> '' THEN
    BEGIN
      v_fven := TRIM(p_f_vencimiento)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;
  IF p_f_vencimiento_actual IS NOT NULL AND TRIM(p_f_vencimiento_actual) <> '' THEN
    BEGIN
      v_fven_actual := TRIM(p_f_vencimiento_actual)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento actual inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;

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
    -- Bucket EXACTO a editar (v1 = bucket vacío; v2 = cualquier bucket mostrado)
    AND COALESCE(TRIM(lote), '') = COALESCE(v_lote_actual, '')
    AND f_vencimiento IS NOT DISTINCT FROM v_fven_actual;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'SIN_FILAS|No hay stock con esos datos para % en esa ubicación (puede que ya se haya corregido)', v_codigo;
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
-- posición). Se actualiza el bucket EXACTO (lote_actual + fecha_actual)
-- del artículo en TODOS los niveles de la posición — mismo criterio de
-- retro-etiquetado consistente que en Racks.
CREATE OR REPLACE FUNCTION public.editar_lote_vencimiento_piso(
  p_posicion_id uuid,
  p_bloque_id uuid,
  p_lote text DEFAULT NULL,
  p_f_vencimiento text DEFAULT NULL,
  p_lote_actual text DEFAULT NULL,
  p_f_vencimiento_actual text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lote        TEXT;
  v_fven        DATE;
  v_lote_actual TEXT;
  v_fven_actual DATE;
  v_rows        INT;
  v_lock        TEXT;
BEGIN
  v_lote        := NULLIF(TRIM(p_lote), '');
  v_lote_actual := NULLIF(TRIM(p_lote_actual), '');

  IF p_f_vencimiento IS NOT NULL AND TRIM(p_f_vencimiento) <> '' THEN
    BEGIN
      v_fven := TRIM(p_f_vencimiento)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;
  IF p_f_vencimiento_actual IS NOT NULL AND TRIM(p_f_vencimiento_actual) <> '' THEN
    BEGIN
      v_fven_actual := TRIM(p_f_vencimiento_actual)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento actual inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;

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
    -- Bucket EXACTO a editar (v1 = bucket vacío; v2 = cualquier bucket mostrado)
    AND COALESCE(TRIM(d.lote), '') = COALESCE(v_lote_actual, '')
    AND d.fecha_vencimiento IS NOT DISTINCT FROM v_fven_actual;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'SIN_FILAS|No hay stock con esos datos para este artículo en esa posición (puede que ya se haya corregido)';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'filas_actualizadas', v_rows,
    'lote', v_lote,
    'f_vencimiento', v_fven
  );
END;
$function$;
