-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — Atención: EDITAR RAL (paridad con la RQ) + TURNO del ledger de
-- tomas + limpieza de índice duplicado (2026-11-12).
--
-- 1) ral_editar: edición supervisada del RAL (encabezado + materiales) en
--    UNA transacción — espejo exacto de rq_editar_rq con las diferencias
--    propias del RAL:
--      · Sin turno/turno_rq (el RAL no es hoja de producción).
--      · Items con CENTRO DE COSTOS (propio del formato RAL) — editable
--        siempre: es metadata de costos, no identidad física del material.
--      · Las MISMAS reglas de integridad física: cantidad nueva < atendida
--        rechaza; código/unidad congelados con atención registrada; quitar
--        material con atención rechaza.
--      · Auditoría en rals.ediciones (columna NUEVA, misma estructura que
--        rq_atenciones.ediciones: quién/cuándo/resumen/cambios, máx 20).
--      · Guard EXACTO de rq_editar_rq: tiene_permiso('atencion.editar') +
--        roles admin / supervisor_almacen / supervisor_operaciones /
--        coordinador_operaciones.
--    SIN defaults en la firma (convención 20261111_rpc_sin_defaults_pgrst203:
--    PostgREST no resuelve sobrecargas con DEFAULT) — el cliente envía los
--    6 parámetros siempre.
--
-- 2) turno de rq_atencion_tomas: la columna existía pero NADIA la llenaba
--    (309/309 filas vacías — la RPC rq_atender_item no la envía). Ahora:
--      · Trigger BEFORE INSERT que llena turno cuando llega vacío
--        (regla del almacén, hora Lima: 07:20:00–19:20:59 → T1, resto T2 —
--        la MISMA de calcularTurnoRecepcion / Excel por rango de Recepción).
--      · Backfill determinista de los 309 históricos desde creado_en.
--
-- 3) DROP del índice duplicado idx_ral_items_ral_id (btree ral_id): el
--    compuesto ral_items_ral_id_idx (ral_id, orden) ya cubre esas lecturas.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1.a) Auditoría de ediciones del RAL ────────────────────────────────────
ALTER TABLE public.rals
  ADD COLUMN IF NOT EXISTS ediciones jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ── 1.b) RPC ral_editar (sin defaults; el cliente envía todos los args) ────
CREATE OR REPLACE FUNCTION public.ral_editar(
  p_ral_id uuid,
  p_encabezado jsonb,
  p_items jsonb,
  p_usuario_id uuid,
  p_usuario_nombre text,
  p_usuario_correo text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ral            rals%ROWTYPE;
  v_ral_json       jsonb;
  v_roles          text[] := ARRAY['admin','supervisor_almacen',
                                  'supervisor_operaciones','coordinador_operaciones'];
  v_item           ral_items%ROWTYPE;
  v_fila           jsonb;
  v_id             uuid;
  v_txt            text;
  v_fecha          date;
  v_codigo         text;
  v_desc           text;
  v_unidad         text;
  v_ccostos        text;
  v_orden          int;
  v_cant           numeric;
  v_diff           jsonb := '[]'::jsonb;
  v_alguno_atendido boolean;
  v_ids_payload    uuid[] := ARRAY[]::uuid[];
  v_ids_ral        uuid[] := ARRAY[]::uuid[];
  v_ids_borrar     uuid[] := ARRAY[]::uuid[];
  v_n_enc          int := 0;
  v_n_upd          int := 0;
  v_n_ins          int := 0;
  v_n_del          int := 0;
  v_pendientes     int;
  v_total_items    int;
  v_estado         text;
  v_estado_antes   text;
  v_cambios_total  int;
BEGIN
  -- __guard_permiso__: mismo cuadro que rq_editar_rq (denegar también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'atencion.editar') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para editar solicitudes (RAL)';
    END IF;
  END IF;

  -- ── Guard de rol (mismos roles que pueden editar/eliminar la RQ) ──
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden editar un RAL';
  ELSIF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role::text = ANY (v_roles)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo supervisores o administradores pueden editar un RAL';
  END IF;

  -- ── RAL existente, bloqueado contra carreras ──
  IF p_ral_id IS NULL THEN
    RAISE EXCEPTION 'RAL_NO_EXISTE|Falta el identificador del RAL';
  END IF;
  SELECT * INTO v_ral FROM rals WHERE id = p_ral_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RAL_NO_EXISTE|El RAL ya no existe (puede haber sido eliminado)';
  END IF;
  v_estado_antes := v_ral.estado;
  v_ral_json := to_jsonb(v_ral);

  -- ── Encabezado: aplica SOLO los campos presentes ──
  FOREACH v_txt IN ARRAY ARRAY['documento','transaccion','area_solicitante',
                               'solicitante','aprobado_por','almacen','linea'] LOOP
    IF p_encabezado ? v_txt THEN
      DECLARE
        v_nuevo text := TRIM(COALESCE(p_encabezado ->> v_txt, ''));
      BEGIN
        IF v_nuevo IS DISTINCT FROM (v_ral_json ->> v_txt) THEN
          v_diff := v_diff || jsonb_build_object(
            'tipo','encabezado', 'campo', v_txt,
            'antes', COALESCE(v_ral_json ->> v_txt, ''),
            'despues', v_nuevo);
          EXECUTE format('UPDATE rals SET %I = $1 WHERE id = $2', v_txt)
            USING v_nuevo, p_ral_id;
          v_ral_json := v_ral_json || jsonb_build_object(v_txt, v_nuevo);
          v_n_enc := v_n_enc + 1;
        END IF;
      END;
    END IF;
  END LOOP;
  -- notas: permite vacío a propósito (limpiar la nota es una corrección válida)
  IF p_encabezado ? 'notas' THEN
    v_txt := COALESCE(p_encabezado ->> 'notas', '');
    IF v_txt IS DISTINCT FROM (v_ral_json ->> 'notas') THEN
      v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','notas',
        'antes', COALESCE(v_ral_json ->> 'notas', ''), 'despues', v_txt);
      UPDATE rals SET notas = v_txt WHERE id = p_ral_id;
      v_ral_json := v_ral_json || jsonb_build_object('notas', v_txt);
      v_n_enc := v_n_enc + 1;
    END IF;
  END IF;
  -- fecha (valida formato de fecha)
  IF p_encabezado ? 'fecha' THEN
    v_txt := TRIM(COALESCE(p_encabezado ->> 'fecha', ''));
    IF v_txt <> '' AND v_txt IS DISTINCT FROM (v_ral_json ->> 'fecha') THEN
      BEGIN
        v_fecha := v_txt::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'FECHA_INVALIDA|La fecha "%" no es válida (usa AAAA-MM-DD)', v_txt;
      END;
      v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','fecha',
        'antes', COALESCE(v_ral_json ->> 'fecha', ''), 'despues', v_txt);
      UPDATE rals SET fecha = v_fecha WHERE id = p_ral_id;
      v_ral_json := v_ral_json || jsonb_build_object('fecha', v_txt);
      v_n_enc := v_n_enc + 1;
    END IF;
  END IF;

  -- ── Items: estado deseado COMPLETO (diff declarativo, como la RQ) ──
  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' AND jsonb_array_length(p_items) > 0 THEN
    IF jsonb_array_length(p_items) > 500 THEN
      RAISE EXCEPTION 'DEMASIADOS_ITEMS|Un RAL admite como máximo 500 materiales';
    END IF;

    -- 4.a) Updates (filas CON id)
    FOR v_fila IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_id := NULLIF(TRIM(COALESCE(v_fila ->> 'id', '')), '');
      IF v_id IS NULL THEN CONTINUE; END IF;
      IF v_id::uuid = ANY (v_ids_payload) THEN
        RAISE EXCEPTION 'ITEM_DUPLICADO|El material % viene dos veces en la edición', v_id;
      END IF;
      v_ids_payload := v_ids_payload || v_id::uuid;

      SELECT * INTO v_item FROM ral_items
        WHERE id = v_id::uuid AND ral_id = p_ral_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ITEM_NO_EXISTE|Un material de la edición ya no pertenece a este RAL (recarga la pantalla e inténtalo de nuevo)';
      END IF;

      v_codigo := UPPER(TRIM(COALESCE(v_fila ->> 'codigo', v_item.codigo)));
      IF v_codigo = '' THEN
        RAISE EXCEPTION 'CODIGO_REQUERIDO|Hay materiales sin código';
      END IF;
      v_cant := COALESCE((v_fila ->> 'cantidad')::numeric, v_item.cantidad);
      IF v_cant IS NULL OR v_cant <= 0 THEN
        RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad de % debe ser mayor que cero', v_codigo;
      END IF;
      -- Misma regla Task 34 de la RQ: solo rechaza si la edición CAMBIA la
      -- cantidad a algo menor que lo atendido (sobreatendido sin tocar pasa).
      IF v_cant <> v_item.cantidad AND v_cant < v_item.cantidad_atendida THEN
        RAISE EXCEPTION 'CANTIDAD_MENOR_ATENDIDA|% pide % pero ya se atendieron %: primero revierte la atención de ese material',
          v_codigo, v_cant, v_item.cantidad_atendida;
      END IF;
      v_unidad := TRIM(COALESCE(v_fila ->> 'unidad', v_item.unidad));
      IF v_unidad = '' THEN v_unidad := v_item.unidad; END IF;
      -- Centro de costos: SIEMPRE editable (metadata de costos, no identidad
      -- física del material — la atención no queda atada a él).
      v_ccostos := TRIM(COALESCE(v_fila ->> 'centro_costos', v_item.centro_costos));
      v_desc := COALESCE(v_fila ->> 'descripcion', v_item.descripcion);
      v_orden := COALESCE((v_fila ->> 'orden')::int, v_item.orden);

      -- Identidad congelada si hubo salida física (igual que la RQ).
      IF v_item.cantidad_atendida > 0
         AND (v_codigo <> UPPER(TRIM(v_item.codigo)) OR v_unidad <> v_item.unidad) THEN
        RAISE EXCEPTION 'ITEM_CON_ATENCION|% ya tiene % atendidos: revierte su atención antes de cambiar el código o la unidad',
          v_item.codigo, v_item.cantidad_atendida;
      END IF;

      IF v_codigo <> v_item.codigo OR v_desc IS DISTINCT FROM v_item.descripcion
         OR v_unidad <> v_item.unidad OR v_ccostos IS DISTINCT FROM v_item.centro_costos
         OR v_cant <> v_item.cantidad OR v_orden <> v_item.orden THEN
        IF v_cant <> v_item.cantidad THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_item.codigo,
            'campo','cantidad','antes',v_item.cantidad,'despues',v_cant);
        END IF;
        IF v_codigo <> v_item.codigo THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_item.codigo,
            'campo','codigo','antes',v_item.codigo,'despues',v_codigo);
        END IF;
        IF v_unidad <> v_item.unidad THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_codigo,
            'campo','unidad','antes',v_item.unidad,'despues',v_unidad);
        END IF;
        IF v_ccostos IS DISTINCT FROM v_item.centro_costos THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_codigo,
            'campo','centro_costos','antes',v_item.centro_costos,'despues',v_ccostos);
        END IF;
        IF v_desc IS DISTINCT FROM v_item.descripcion THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_codigo,
            'campo','descripcion','antes',v_item.descripcion,'despues',v_desc);
        END IF;
        UPDATE ral_items SET
          codigo = v_codigo, descripcion = v_desc, unidad = v_unidad,
          centro_costos = v_ccostos, cantidad = v_cant, orden = v_orden
        WHERE id = v_item.id;
        v_n_upd := v_n_upd + 1;
      END IF;
    END LOOP;

    -- 4.b) Deletes (materiales del RAL AUSENTES del payload)
    SELECT array_agg(id ORDER BY id) INTO v_ids_ral
      FROM ral_items WHERE ral_id = p_ral_id;
    SELECT array_agg(x ORDER BY x) INTO v_ids_borrar
      FROM unnest(COALESCE(v_ids_ral, ARRAY[]::uuid[])) AS x
      WHERE NOT (x = ANY (v_ids_payload));
    FOREACH v_id IN ARRAY COALESCE(v_ids_borrar, ARRAY[]::uuid[]) LOOP
      SELECT * INTO v_item FROM ral_items WHERE id = v_id FOR UPDATE;
      IF v_item.cantidad_atendida > 0 THEN
        RAISE EXCEPTION 'ITEM_CON_ATENCION|% tiene % atendidos: revierte su atención antes de quitarlo del RAL',
          v_item.codigo, v_item.cantidad_atendida;
      END IF;
      DELETE FROM ral_items WHERE id = v_item.id;
      v_diff := v_diff || jsonb_build_object('tipo','material_quitado','item',v_item.codigo,
        'descripcion',v_item.descripcion,'cantidad',v_item.cantidad,'unidad',v_item.unidad);
      v_n_del := v_n_del + 1;
    END LOOP;

    -- 4.c) Inserts (filas SIN id = materiales nuevos)
    FOR v_fila IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_id := NULLIF(TRIM(COALESCE(v_fila ->> 'id', '')), '');
      IF v_id IS NOT NULL THEN CONTINUE; END IF;
      v_codigo := UPPER(TRIM(COALESCE(v_fila ->> 'codigo', '')));
      IF v_codigo = '' THEN
        RAISE EXCEPTION 'CODIGO_REQUERIDO|Hay materiales nuevos sin código';
      END IF;
      v_cant := COALESCE((v_fila ->> 'cantidad')::numeric, 0);
      IF v_cant IS NULL OR v_cant <= 0 THEN
        RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad de % debe ser mayor que cero', v_codigo;
      END IF;
      v_unidad := TRIM(COALESCE(v_fila ->> 'unidad', ''));
      v_ccostos := TRIM(COALESCE(v_fila ->> 'centro_costos', ''));
      v_desc   := TRIM(COALESCE(v_fila ->> 'descripcion', ''));
      v_orden  := COALESCE((v_fila ->> 'orden')::int,
                           (SELECT COALESCE(MAX(orden), -1) + 1
                              FROM ral_items WHERE ral_id = p_ral_id));
      INSERT INTO ral_items
        (ral_id, orden, codigo, descripcion, unidad, centro_costos, cantidad, cantidad_atendida)
      VALUES (p_ral_id, v_orden, v_codigo, v_desc, v_unidad, v_ccostos, v_cant, 0)
      RETURNING * INTO v_item;
      v_n_ins := v_n_ins + 1;
      v_diff := v_diff || jsonb_build_object('tipo','material_agregado','item',v_codigo,
        'descripcion',v_desc,'cantidad',v_cant,'unidad',v_unidad);
    END LOOP;
  END IF;

  -- ── Recalcula el estado (regla canónica unificada RQ/RAL) ──
  SELECT count(*) INTO v_pendientes
    FROM ral_items
    WHERE ral_id = p_ral_id AND cantidad_atendida < cantidad;
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM ral_items WHERE ral_id = p_ral_id AND cantidad_atendida > 0
  ), false) INTO v_alguno_atendido;
  SELECT count(*) INTO v_total_items FROM ral_items WHERE ral_id = p_ral_id;
  v_estado := CASE
    WHEN v_total_items = 0 THEN v_estado_antes        -- sin materiales: no tocar
    WHEN v_pendientes = 0 THEN 'Atendido'
    WHEN v_alguno_atendido THEN 'En proceso'
    ELSE 'Pendiente' END;
  IF v_estado IS DISTINCT FROM v_estado_antes THEN
    v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','estado',
      'antes', v_estado_antes, 'despues', v_estado);
    v_n_enc := v_n_enc + 1;
  END IF;

  v_cambios_total := v_n_enc + v_n_upd + v_n_ins + v_n_del;

  -- ── Auditoría (solo ediciones REALES; no-op no ensucia el historial) ──
  IF v_cambios_total > 0 THEN
    DECLARE
      v_cambio jsonb;
    BEGIN
      v_cambio := jsonb_build_object(
        'en', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
        'usuario_id',   COALESCE(p_usuario_id::text, ''),
        'usuario_nombre', COALESCE(NULLIF(TRIM(COALESCE(p_usuario_nombre,'')), ''), '—'),
        'usuario_correo', COALESCE(p_usuario_correo, ''),
        'resumen', jsonb_build_object(
          'encabezado', v_n_enc, 'materiales_editados', v_n_upd,
          'materiales_agregados', v_n_ins, 'materiales_quitados', v_n_del),
        'cambios', v_diff);
      UPDATE rals SET
        estado = v_estado,
        ediciones = (
          SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (
            SELECT e FROM jsonb_array_elements(v_cambio || COALESCE(ediciones, '[]'::jsonb))
              WITH ORDINALITY AS t(e, ord) ORDER BY ord LIMIT 20
          ) ultimas
        )
      WHERE id = p_ral_id;
    END;
  END IF;

  -- ── Resultado: RAL + items + nº de cambios aplicados ──
  RETURN jsonb_build_object(
    'ral', (SELECT to_jsonb(r) FROM rals r WHERE r.id = p_ral_id),
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(it) ORDER BY it.orden, it.created_at)
        FROM ral_items it WHERE it.ral_id = p_ral_id
    ), '[]'::jsonb),
    'cambios', v_cambios_total);
END
$function$;

-- ── 2) TURNO del ledger de tomas ──────────────────────────────────────────
-- Regla del almacén (hora LIMA, idéntica a calcularTurnoRecepcion):
-- 07:20:00–19:20:59 → T1 · 19:21:00–07:19:59 → T2.
CREATE OR REPLACE FUNCTION public.rq_toma_turno_auto()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_min int;
BEGIN
  IF COALESCE(NEW.turno, '') = '' THEN
    SELECT (EXTRACT(hour FROM t) * 60 + EXTRACT(minute FROM t))::int
      INTO v_min
      FROM (SELECT (NEW.creado_en AT TIME ZONE 'America/Lima') AS t) s;
    NEW.turno := CASE
      WHEN v_min >= (7 * 60 + 20) AND v_min <= (19 * 60 + 20) THEN 'T1'
      ELSE 'T2' END;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS trg_rq_tomas_turno ON public.rq_atencion_tomas;
CREATE TRIGGER trg_rq_tomas_turno
  BEFORE INSERT ON public.rq_atencion_tomas
  FOR EACH ROW EXECUTE FUNCTION public.rq_toma_turno_auto();

-- Backfill determinista de los históricos (turno derivado de creado_en, Lima)
UPDATE public.rq_atencion_tomas
SET turno = CASE
  WHEN (EXTRACT(hour FROM (creado_en AT TIME ZONE 'America/Lima')) * 60
        + EXTRACT(minute FROM (creado_en AT TIME ZONE 'America/Lima')))
       BETWEEN (7 * 60 + 20) AND (19 * 60 + 20)
  THEN 'T1' ELSE 'T2' END
WHERE COALESCE(turno, '') = '';

-- ── 3) Índice duplicado fuera (el compuesto (ral_id, orden) lo cubre) ──────
DROP INDEX IF EXISTS public.idx_ral_items_ral_id;
