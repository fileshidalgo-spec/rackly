-- ═══════════════════════════════════════════════════════════════════
-- Task 35 · Módulo Atención — TURNO DEL RQ (hoja física 004/005)
--
-- La hoja física de la Requisición trae su propio turno ("Turno: 004" =
-- turno 1 · "005" = turno 2), que puede DIFIERIR del turno del sistema
-- (hora de registro): una RQ entregada en la madrugada pertenece al
-- turno del día siguiente. Hoy rq_atenciones solo guarda el turno del
-- sistema → se agrega turno_rq (nullable: históricos sin dato caen al
-- turno del sistema vía COALESCE en los filtros).
--
-- 1) ALTER TABLE ... ADD COLUMN turno_rq text  (nullable, sin default)
-- 2) RPC rq_crear_completa: inserta turno_rq (valida T1/T2 si viene)
-- 3) RPC rq_editar_rq: whitelist del encabezado + turno_rq (editable)
-- ═══════════════════════════════════════════════════════════════════

-- ── 1) Columna nueva (idempotente) ─────────────────────────────────
ALTER TABLE public.rq_atenciones
  ADD COLUMN IF NOT EXISTS turno_rq text;

COMMENT ON COLUMN public.rq_atenciones.turno_rq IS
  'Task 35: turno de la hoja física de la RQ (004=T1, 005=T2). NULL = histórico/indicado: el filtro usa el turno del sistema.';

-- ── 2) RPC rq_crear_completa (añade turno_rq al INSERT) ────────────
CREATE OR REPLACE FUNCTION public.rq_crear_completa(p_rq jsonb, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id      uuid;
  v_item    jsonb;
  v_turno_rq text;
BEGIN
  v_id := (p_rq->>'id')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'ID_REQUERIDO|la RQ debe traer id preasignado (idempotencia)';
  END IF;

  -- Task 35: turno de la hoja física (004=T1, 005=T2). Vacío = no indicado.
  v_turno_rq := nullif(btrim(coalesce(p_rq->>'turno_rq', '')), '');
  IF v_turno_rq IS NOT NULL AND v_turno_rq NOT IN ('T1', 'T2') THEN
    RAISE EXCEPTION 'TURNO_RQ_INVALIDO|El turno del RQ debe ser T1 o T2 (recibido: "%")', v_turno_rq;
  END IF;

  INSERT INTO rq_atenciones (
    id, fecha, numero_rq, orden_produccion, producto_codigo,
    producto_descripcion, turno, turno_rq, linea, solicitante, estado,
    foto_url, notas, usuario_id, usuario_nombre, usuario_correo
  ) VALUES (
    v_id,
    coalesce((p_rq->>'fecha')::date, CURRENT_DATE),
    coalesce(p_rq->>'numero_rq', ''),
    coalesce(p_rq->>'orden_produccion', ''),
    coalesce(p_rq->>'producto_codigo', ''),
    coalesce(p_rq->>'producto_descripcion', ''),
    coalesce(p_rq->>'turno', 'T1'),
    v_turno_rq,
    coalesce(p_rq->>'linea', ''),
    coalesce(p_rq->>'solicitante', ''),
    'Pendiente',
    coalesce(p_rq->>'foto_url', ''),
    coalesce(p_rq->>'notas', ''),
    coalesce(NULLIF(btrim(coalesce(p_rq->>'usuario_id','')), '')::uuid,
             '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(p_rq->>'usuario_nombre', ''),
    coalesce(p_rq->>'usuario_correo', '')
  )
  ON CONFLICT (id) DO NOTHING;

  -- Materiales: inserta SOLO los que faltan (idempotente ante reintento).
  -- Llave natural de reenvío: (rq_id, orden, codigo) — el orden es la
  -- posición de la fila y no puede repetirse dentro de la misma RQ.
  FOR v_item IN
    SELECT * FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
    )
  LOOP
    INSERT INTO rq_atencion_items (
      rq_id, orden, codigo, descripcion, unidad, cantidad, cantidad_atendida
    )
    SELECT
      v_id,
      coalesce((v_item->>'orden')::int, 0),
      coalesce(v_item->>'codigo', ''),
      coalesce(v_item->>'descripcion', ''),
      coalesce(v_item->>'unidad', ''),
      coalesce((v_item->>'cantidad')::numeric, 0),
      0
    WHERE NOT EXISTS (
      SELECT 1 FROM rq_atencion_items x
      WHERE x.rq_id  = v_id
        AND x.orden  = coalesce((v_item->>'orden')::int, 0)
        AND x.codigo = coalesce(v_item->>'codigo', '')
    );
  END LOOP;

  RETURN v_id;
END;
$function$;
