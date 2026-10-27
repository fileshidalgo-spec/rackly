-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · Task 26 (Módulo ATENCIÓN) — Edición supervisada de una RQ
--
-- Problema (auditoría 2026-10-27):
--   Una RQ registrada (foto/OCR o manual) era INCORREGIBLE. Si el
--   supervisor detectaba una línea errada al atender (código mal leído,
--   cantidad equivocada, material que no era, o encabezado errado —
--   p. ej. el campo Línea), las únicas salidas eran:
--     · Eliminar la RQ completa → perdía TODO el avance de atención
--       (cantidad_atendida) y la foto, y las tomas del puente quedaban
--       desacopladas del documento.
--     · Convivir con el error → el material equivocado salía físico o la
--       RQ quedaba eternamente "En proceso".
--
-- Solución: UNA transacción en la BD (diff declarativo):
--   · Encabezado: corrige SOLO los campos presentes en p_encabezado.
--   · Items (p_items = estado deseado COMPLETO):
--       - con id      → UPDATE (código/descripción/unidad/cantidad/orden)
--       - sin id      → INSERT (material nuevo)
--       - ausentes    → DELETE (SOLO si cantidad_atendida = 0)
--     p_items vacío/NULL = "no tocar materiales" (edición solo de encabezado).
--   · Guardas de integridad física:
--       - cantidad nueva < cantidad_atendida cruzando el umbral (la cantidad
--         de origen lo cubría) → RECHAZA: no se puede pedir menos de lo que ya
--         salió del almacén por una edición (primero revertir). Un excedente
--         preexistente (atendida > cantidad de origen) NO bloquea (Task 34).
--       - código/unidad de un item con atención registrada → RECHAZA
--         (la salida física quedó asociada a ese material).
--       - eliminar item con atención registrada → RECHAZA (mismo motivo).
--   · Recalcula el estado del encabezado (misma regla que rq_atender_item /
--     rq_revertir_item: Pendiente / En proceso / Atendido).
--   · AUDITORÍA (admins ven todo): cada edición REAL (no-op excluido) añade
--     una entrada a rq_atenciones.ediciones (jsonb, máx 20, más reciente
--     primero) con quién/cuándo/qué cambió (antes → después). La tabla
--     movimientos NO se toca: es el kardex del stock físico (salida/ingreso/
--     traslado/devolución) y mezclar ediciones administrativas la corrompería.
--
-- Seguridad: SECURITY DEFINER con search_path fijo (patrón rq_atender_lote).
-- Guard de rol DENTRO de la función: mismos roles que pueden eliminar una RQ
-- (RLS rq_delete_auth: admin, supervisor_almacen, supervisor_operaciones,
-- coordinador_operaciones). EXECUTE solo para authenticated + service_role.
-- Ejecutar como admin (MAPI). Re-ejecutable (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════

-- Columna de auditoría de ediciones (append-only lógico, máx 20 entradas)
ALTER TABLE public.rq_atenciones
  ADD COLUMN IF NOT EXISTS ediciones jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.rq_editar_rq(
  p_rq_id          uuid,
  p_encabezado     jsonb DEFAULT '{}'::jsonb,
  p_items          jsonb DEFAULT '[]'::jsonb,
  p_usuario_id     uuid DEFAULT NULL,
  p_usuario_nombre text DEFAULT '',
  p_usuario_correo text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rq            rq_atenciones%ROWTYPE;
  v_rq_json       jsonb;
  v_roles         text[] := ARRAY['admin','supervisor_almacen',
                                  'supervisor_operaciones','coordinador_operaciones'];
  v_item          rq_atencion_items%ROWTYPE;
  v_fila          jsonb;
  v_id            uuid;
  v_txt           text;
  v_fecha         date;
  v_codigo        text;
  v_desc          text;
  v_unidad        text;
  v_orden         int;
  v_cant          numeric;
  v_diff          jsonb := '[]'::jsonb;
  v_alguno_atendido boolean;
  v_ids_payload   uuid[] := ARRAY[]::uuid[];
  v_ids_rq        uuid[] := ARRAY[]::uuid[];
  v_ids_borrar    uuid[] := ARRAY[]::uuid[];
  v_n_enc         int := 0;
  v_n_upd         int := 0;
  v_n_ins         int := 0;
  v_n_del         int := 0;
  v_pendientes    int;
  v_total_items   int;
  v_estado        text;
  v_estado_antes  text;
  v_cambio        jsonb;
  v_cambios_total int;
BEGIN
  -- ── 1) Guard de rol (mismos roles que pueden ELIMINAR la RQ) ──────────
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL; -- operaciones internas del sistema
  ELSIF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden editar una RQ';
  ELSIF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role::text = ANY (v_roles)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo supervisores o administradores pueden editar una RQ';
  END IF;

  -- ── 2) RQ existente, bloqueada contra carreras ────────────────────────
  IF p_rq_id IS NULL THEN
    RAISE EXCEPTION 'RQ_NO_EXISTE|Falta el identificador de la RQ';
  END IF;
  SELECT * INTO v_rq FROM rq_atenciones WHERE id = p_rq_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RQ_NO_EXISTE|La RQ ya no existe (puede haber sido eliminada)';
  END IF;
  v_estado_antes := v_rq.estado;
  v_rq_json := to_jsonb(v_rq);  -- lectura genérica campo-por-campo (dif de encabezado)

  -- ── 3) Encabezado: aplica SOLO los campos presentes ───────────────────
  -- numero_rq / orden_produccion / producto_codigo / producto_descripcion /
  -- linea / solicitante / notas  (texto, trim; NOTA permite vacío)
  FOREACH v_txt IN ARRAY ARRAY['numero_rq','orden_produccion','producto_codigo',
                               'producto_descripcion','linea','solicitante'] LOOP
    IF p_encabezado ? v_txt THEN
      DECLARE
        v_nuevo text := TRIM(COALESCE(p_encabezado ->> v_txt, ''));
      BEGIN
        IF v_nuevo IS DISTINCT FROM (v_rq_json ->> v_txt) THEN
          v_diff := v_diff || jsonb_build_object(
            'tipo','encabezado', 'campo', v_txt,
            'antes', COALESCE(v_rq_json ->> v_txt, ''),
            'despues', v_nuevo);
          EXECUTE format('UPDATE rq_atenciones SET %I = $1 WHERE id = $2', v_txt)
            USING v_nuevo, p_rq_id;
          v_rq_json := v_rq_json || jsonb_build_object(v_txt, v_nuevo);
          v_n_enc := v_n_enc + 1;
        END IF;
      END;
    END IF;
  END LOOP;
  -- notas: permite vacío a propósito (limpiar la nota es una corrección válida)
  IF p_encabezado ? 'notas' THEN
    v_txt := COALESCE(p_encabezado ->> 'notas', '');
    IF v_txt IS DISTINCT FROM (v_rq_json ->> 'notas') THEN
      v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','notas',
        'antes', COALESCE(v_rq_json ->> 'notas', ''), 'despues', v_txt);
      UPDATE rq_atenciones SET notas = v_txt WHERE id = p_rq_id;
      v_rq_json := v_rq_json || jsonb_build_object('notas', v_txt);
      v_n_enc := v_n_enc + 1;
    END IF;
  END IF;
  -- fecha (valida formato YYYY-MM-DD)
  IF p_encabezado ? 'fecha' THEN
    v_txt := TRIM(COALESCE(p_encabezado ->> 'fecha', ''));
    IF v_txt <> '' AND v_txt IS DISTINCT FROM (v_rq_json ->> 'fecha') THEN
      BEGIN
        v_fecha := v_txt::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'FECHA_INVALIDA|La fecha "%" no es válida (usa AAAA-MM-DD)', v_txt;
      END;
      v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','fecha',
        'antes', COALESCE(v_rq_json ->> 'fecha', ''), 'despues', v_txt);
      UPDATE rq_atenciones SET fecha = v_fecha WHERE id = p_rq_id;
      v_rq_json := v_rq_json || jsonb_build_object('fecha', v_txt);
      v_n_enc := v_n_enc + 1;
    END IF;
  END IF;
  -- turno (T1/T2)
  IF p_encabezado ? 'turno' THEN
    v_txt := TRIM(COALESCE(p_encabezado ->> 'turno', ''));
    IF v_txt <> '' AND v_txt IS DISTINCT FROM (v_rq_json ->> 'turno') THEN
      IF v_txt NOT IN ('T1','T2') THEN
        RAISE EXCEPTION 'TURNO_INVALIDO|El turno debe ser T1 o T2 (recibido: "%")', v_txt;
      END IF;
      v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','turno',
        'antes', COALESCE(v_rq_json ->> 'turno', ''), 'despues', v_txt);
      UPDATE rq_atenciones SET turno = v_txt WHERE id = p_rq_id;
      v_rq_json := v_rq_json || jsonb_build_object('turno', v_txt);
      v_n_enc := v_n_enc + 1;
    END IF;
  END IF;

  -- ── 4) Items: estado deseado COMPLETO (diff declarativo) ─────────────
  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' AND jsonb_array_length(p_items) > 0 THEN
    IF jsonb_array_length(p_items) > 500 THEN
      RAISE EXCEPTION 'DEMASIADOS_ITEMS|Una RQ admite como máximo 500 materiales';
    END IF;

    -- 4.a) Updates (filas CON id) + colección de ids presentes
    FOR v_fila IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_id := NULLIF(TRIM(COALESCE(v_fila ->> 'id', '')), '');
      IF v_id IS NULL THEN CONTINUE; END IF;
      IF v_id::uuid = ANY (v_ids_payload) THEN
        RAISE EXCEPTION 'ITEM_DUPLICADO|El material % viene dos veces en la edición', v_id;
      END IF;
      v_ids_payload := v_ids_payload || v_id::uuid;

      SELECT * INTO v_item FROM rq_atencion_items
        WHERE id = v_id::uuid AND rq_id = p_rq_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ITEM_NO_EXISTE|Un material de la edición ya no pertenece a esta RQ (recarga la pantalla e inténtalo de nuevo)';
      END IF;

      v_codigo := UPPER(TRIM(COALESCE(v_fila ->> 'codigo', v_item.codigo)));
      IF v_codigo = '' THEN
        RAISE EXCEPTION 'CODIGO_REQUERIDO|Hay materiales sin código';
      END IF;
      v_cant := COALESCE((v_fila ->> 'cantidad')::numeric, v_item.cantidad);
      IF v_cant IS NULL OR v_cant <= 0 THEN
        RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad de % debe ser mayor que cero', v_codigo;
      END IF;
      -- FIX Task 34 (regla = espejo exacto de validarEdicionRq): solo rechaza
      -- cuando la edición CRUZA el umbral hacia abajo (la cantidad de origen
      -- SÍ cubría lo atendido y la nueva la deja por debajo). Un excedente
      -- PREEXISTENTE (atendida > cantidad de origen, caso legítimo de atender
      -- de más) NO bloquea la edición de la RQ: antes, CUALQUIER guardado de
      -- una RQ con excedente era rechazado aunque no se tocara esa fila.
      IF v_cant < v_item.cantidad_atendida AND v_item.cantidad >= v_item.cantidad_atendida THEN
        RAISE EXCEPTION 'CANTIDAD_MENOR_ATENDIDA|% pide % pero ya se atendieron %: primero revierte la atención de ese material',
          v_codigo, v_cant, v_item.cantidad_atendida;
      END IF;
      v_unidad := TRIM(COALESCE(v_fila ->> 'unidad', v_item.unidad));
      IF v_unidad = '' THEN v_unidad := v_item.unidad; END IF;
      v_desc := COALESCE(v_fila ->> 'descripcion', v_item.descripcion);
      v_orden := COALESCE((v_fila ->> 'orden')::int, v_item.orden);

      -- Identidad congelada si hubo salida física (la atención quedó atada
      -- a ESE código/unidad): cambiarlos corrompería el rastro del material.
      IF v_item.cantidad_atendida > 0
         AND (v_codigo <> UPPER(TRIM(v_item.codigo)) OR v_unidad <> v_item.unidad) THEN
        RAISE EXCEPTION 'ITEM_CON_ATENCION|% ya tiene % atendidos: revierte su atención antes de cambiar el código o la unidad',
          v_item.codigo, v_item.cantidad_atendida;
      END IF;

      IF v_codigo <> v_item.codigo OR v_desc IS DISTINCT FROM v_item.descripcion
         OR v_unidad <> v_item.unidad OR v_cant <> v_item.cantidad
         OR v_orden <> v_item.orden THEN
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
        IF v_desc IS DISTINCT FROM v_item.descripcion THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_codigo,
            'campo','descripcion','antes',v_item.descripcion,'despues',v_desc);
        END IF;
        UPDATE rq_atencion_items SET
          codigo = v_codigo, descripcion = v_desc, unidad = v_unidad,
          cantidad = v_cant, orden = v_orden
        WHERE id = v_item.id;
        v_n_upd := v_n_upd + 1;
      END IF;
    END LOOP;

    -- 4.b) Deletes (items de la RQ AUSENTES del payload)
    SELECT array_agg(id ORDER BY id) INTO v_ids_rq
      FROM rq_atencion_items WHERE rq_id = p_rq_id;
    SELECT array_agg(x ORDER BY x) INTO v_ids_borrar
      FROM unnest(COALESCE(v_ids_rq, ARRAY[]::uuid[])) AS x
      WHERE NOT (x = ANY (v_ids_payload));
    FOREACH v_id IN ARRAY COALESCE(v_ids_borrar, ARRAY[]::uuid[]) LOOP
      SELECT * INTO v_item FROM rq_atencion_items WHERE id = v_id FOR UPDATE;
      IF v_item.cantidad_atendida > 0 THEN
        RAISE EXCEPTION 'ITEM_CON_ATENCION|% tiene % atendidos: revierte su atención antes de quitarlo de la RQ',
          v_item.codigo, v_item.cantidad_atendida;
      END IF;
      DELETE FROM rq_atencion_items WHERE id = v_item.id;
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
      v_desc   := TRIM(COALESCE(v_fila ->> 'descripcion', ''));
      v_orden  := COALESCE((v_fila ->> 'orden')::int,
                           (SELECT COALESCE(MAX(orden), -1) + 1
                              FROM rq_atencion_items WHERE rq_id = p_rq_id));
      INSERT INTO rq_atencion_items
        (rq_id, orden, codigo, descripcion, unidad, cantidad, cantidad_atendida)
      VALUES (p_rq_id, v_orden, v_codigo, v_desc, v_unidad, v_cant, 0)
      RETURNING * INTO v_item;
      v_n_ins := v_n_ins + 1;
      v_diff := v_diff || jsonb_build_object('tipo','material_agregado','item',v_codigo,
        'descripcion',v_desc,'cantidad',v_cant,'unidad',v_unidad);
    END LOOP;
  END IF;

  -- ── 5) Recalcula el estado del encabezado (regla canónica unificada) ──
  -- Atendido: nada pendiente · En proceso: hay algo atendido · Pendiente:
  -- nada atendido. Misma regla para rq_atender_item / rq_revertir_item
  -- (ver abajo): antes cada RPC tenía la suya y el estado divergía.
  SELECT count(*) INTO v_pendientes
    FROM rq_atencion_items
    WHERE rq_id = p_rq_id AND cantidad_atendida < cantidad;
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM rq_atencion_items WHERE rq_id = p_rq_id AND cantidad_atendida > 0
  ), false) INTO v_alguno_atendido;
  SELECT count(*) INTO v_total_items FROM rq_atencion_items WHERE rq_id = p_rq_id;
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

  -- ── 6) Auditoría (solo ediciones REALES; no-op no ensucia el historial) ─
  IF v_cambios_total > 0 THEN
    v_cambio := jsonb_build_object(
      'en', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
      'usuario_id',   COALESCE(p_usuario_id::text, ''),
      'usuario_nombre', COALESCE(NULLIF(TRIM(COALESCE(p_usuario_nombre,'')), ''), '—'),
      'usuario_correo', COALESCE(p_usuario_correo, ''),
      'resumen', jsonb_build_object(
        'encabezado', v_n_enc, 'materiales_editados', v_n_upd,
        'materiales_agregados', v_n_ins, 'materiales_quitados', v_n_del),
      'cambios', v_diff);
    UPDATE rq_atenciones SET
      estado = v_estado,
      ediciones = (
        SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (
          SELECT e FROM jsonb_array_elements(v_cambio || COALESCE(ediciones, '[]'::jsonb))
            WITH ORDINALITY AS t(e, ord) ORDER BY ord LIMIT 20
        ) ultimas
      )
    WHERE id = p_rq_id;
  END IF;

  -- ── 7) Resultado: RQ + items + nº de cambios aplicados ────────────────
  RETURN jsonb_build_object(
    'rq', (SELECT to_jsonb(r) FROM rq_atenciones r WHERE r.id = p_rq_id),
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(it) ORDER BY it.orden, it.created_at)
        FROM rq_atencion_items it WHERE it.rq_id = p_rq_id
    ), '[]'::jsonb),
    'cambios', v_cambios_total);
END
$fn$;

-- EXECUTE solo para autenticados (parity con rq_crear_completa; nada para anon)
REVOKE ALL ON FUNCTION public.rq_editar_rq(uuid, jsonb, jsonb, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rq_editar_rq(uuid, jsonb, jsonb, uuid, text, text)
  TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════
-- Consistencia (hallazgo 3 de la auditoría): rq_atender_item y
-- rq_revertir_item tenían CADA UNA su regla de estado del encabezado:
--   · atender: pendientes=0 → Atendido, SIEMPRE 'En proceso' en otro caso.
--   · revertir: podía dejar 'Pendiente' una RQ con atención parcial
--     (p. ej. A=5/10 atendido, B=0/20 → pendientes=total → 'Pendiente').
-- Regla canónica unificada (idéntica a la de rq_editar_rq):
--   Atendido: nada pendiente · En proceso: hay algo atendido · Pendiente:
--   nada atendido. Solo cambia el caso límite de revertir; atender es
--   equivalentemente idéntico (su else implica siempre atención registrada).
-- El resto de cada función se copia VERBATIM de su v8 vigente.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rq_atender_item(p_item_id uuid, p_cantidad numeric, p_usuario text)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
declare
  v_item rq_atencion_items%ROWTYPE;
  v_pendientes integer;
  v_alguno boolean;
begin
  -- v8 (auditoría 2026-10-23): guard de rol, consistente con rq_atender_lote.
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden atender materiales';
  END IF;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a atender debe ser mayor que cero';
  end if;

  -- v8: incremento ATÓMICO en un solo UPDATE.
  update rq_atencion_items set
    cantidad_atendida = cantidad_atendida + p_cantidad,
    usuario_atencion = coalesce(nullif(p_usuario, ''), usuario_atencion),
    atendido_en = case when cantidad_atendida + p_cantidad >= cantidad then now() else null end
  where id = p_item_id
  returning * into v_item;

  if not found then
    raise exception 'Artículo no encontrado (puede haber sido eliminado)';
  end if;

  -- v9 (Task 26): regla canónica de estado (unificada con revertir/editar).
  select count(*) into v_pendientes
    from rq_atencion_items
    where rq_id = v_item.rq_id and cantidad_atendida < cantidad;
  select coalesce(exists(
    select 1 from rq_atencion_items where rq_id = v_item.rq_id and cantidad_atendida > 0
  ), false) into v_alguno;

  update rq_atenciones set
    estado = case
      when v_pendientes = 0 then 'Atendido'
      when v_alguno then 'En proceso'
      else 'Pendiente' end
  where id = v_item.rq_id;

  return to_json(v_item);
end $function$;

CREATE OR REPLACE FUNCTION public.rq_revertir_item(p_item_id uuid, p_cantidad numeric)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
declare
  v_item rq_atencion_items%ROWTYPE;
  v_pendientes integer;
  v_alguno boolean;
begin
  -- v8 (auditoría 2026-10-23): guard de rol + decremento ATÓMICO.
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden revertir atenciones';
  END IF;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a revertir debe ser mayor que cero';
  end if;

  update rq_atencion_items set
    cantidad_atendida = greatest(cantidad_atendida - p_cantidad, 0),
    atendido_en = case when greatest(cantidad_atendida - p_cantidad, 0) >= cantidad then atendido_en else null end
  where id = p_item_id
  returning * into v_item;

  if not found then
    raise exception 'Artículo no encontrado';
  end if;

  -- v9 (Task 26): regla canónica de estado (unificada con atender/editar).
  select count(*) into v_pendientes
    from rq_atencion_items
    where rq_id = v_item.rq_id and cantidad_atendida < cantidad;
  select coalesce(exists(
    select 1 from rq_atencion_items where rq_id = v_item.rq_id and cantidad_atendida > 0
  ), false) into v_alguno;

  update rq_atenciones set
    estado = case
      when v_pendientes = 0 then 'Atendido'
      when v_alguno then 'En proceso'
      else 'Pendiente' end
  where id = v_item.rq_id;

  return to_json(v_item);
end $function$;
