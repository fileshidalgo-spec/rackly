-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY · Task 27 (Módulo Atención) — LEDGER DE TOMAS DE ATENCIÓN
--
-- Problema (paso 1.2 del usuario): la atención de una RQ era un CONTADOR
-- agregado (rq_atencion_items.cantidad_atendida) sin registro de tomas por
-- posición. El supervisor/administrador no podía responder «¿desde qué
-- posiciones se atendió este material y cuánto saldo quedó en cada una?».
-- Además, los materiales YA ATENDIDOS quedaban congelados en el editor sin
-- un camino guiado de reversa.
--
-- Solución (paso 4, aditiva — paso 5 sin conflictos):
--   1) Tabla rq_atencion_tomas: ledger APPEND-ONLY por toma (origen,
--      ubicación, cantidad, saldo_resultante, usuario). Sobrevive al borrado
--      de la RQ (sin FK a propósito: es auditoría).
--   2) rq_atender_item v10: parámetro OPCIONAL p_toma (posiciones de la
--      salida registrada en la RQ) + toma 'manual' por defecto.
--   3) rq_revertir_item v10: la reversa queda en el ledger (cantidad −).
--   4) rq_atender_lote v3: cada toma del puente QR queda en el ledger
--      (transito/racks/piso) — mismo formato de etiqueta que el app.
--   5) rq_revertir_origen v3: cada reversa del puente queda en el ledger.
--   · movimientos (kardex), registrar_movimiento_kardex y piso_registrar_salida
--     NO se tocan. Firmas existentes intactas: solo parámetros OPCIONALES al
--     final → compatibles con todas las llamadas actuales.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1) TABLA rq_atencion_tomas
--    origen: 'racks' (salida física de posición Rack) · 'piso' (posición Piso)
--            'transito' (descuento de guía) · 'manual' (atención digitada sin
--            posición) · 'reversa' (devolución; cantidad NEGATIVA).
--    saldo_resultante: saldo de la posición TRAS la toma (exacto en ruta
--            racks del puente; NULL donde la BD no lo reporta).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rq_atencion_tomas (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rq_id             uuid NOT NULL,
  item_id           uuid NOT NULL,
  codigo            text NOT NULL DEFAULT '',
  origen            text NOT NULL DEFAULT 'manual',
  cantidad          numeric NOT NULL,
  ubicacion         text NOT NULL DEFAULT '',
  saldo_resultante  numeric,
  rack              jsonb,
  piso              jsonb,
  lote              text NOT NULL DEFAULT '',
  usuario_id        uuid,
  usuario_nombre    text NOT NULL DEFAULT '',
  usuario_correo    text NOT NULL DEFAULT '',
  turno             text NOT NULL DEFAULT '',
  creado_en         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rq_atencion_tomas IS
  'Ledger de tomas de atención de RQ (Task 27): una fila por salida/reversa con su posición y saldo. Append-only: reversa = fila con cantidad negativa.';

CREATE INDEX IF NOT EXISTS idx_rq_tomas_item   ON public.rq_atencion_tomas (item_id);
CREATE INDEX IF NOT EXISTS idx_rq_tomas_rq     ON public.rq_atencion_tomas (rq_id);
CREATE INDEX IF NOT EXISTS idx_rq_tomas_codigo ON public.rq_atencion_tomas (codigo, creado_en);

ALTER TABLE public.rq_atencion_tomas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rq_tomas_select_auth  ON public.rq_atencion_tomas;
DROP POLICY IF EXISTS rq_tomas_insert_auth  ON public.rq_atencion_tomas;
DROP POLICY IF EXISTS rq_tomas_update_auth  ON public.rq_atencion_tomas;
DROP POLICY IF EXISTS rq_tomas_delete_auth  ON public.rq_atencion_tomas;

-- Lectura: todos los autenticados (igual que rq_atencion_items).
CREATE POLICY rq_tomas_select_auth ON public.rq_atencion_tomas
  FOR SELECT TO authenticated USING (true);

-- Escritura de tomas: autenticados (las RPC validan el resto).
CREATE POLICY rq_tomas_insert_auth ON public.rq_atencion_tomas
  FOR INSERT TO authenticated WITH CHECK (true);

-- Corrección/borrado del ledger: mismos roles que gestionan RQs (rq_delete_auth).
CREATE POLICY rq_tomas_update_auth ON public.rq_atencion_tomas
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = ANY (ARRAY['admin'::app_role,
                                 'supervisor_almacen'::app_role,
                                 'supervisor_operaciones'::app_role,
                                 'coordinador_operaciones'::app_role])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = ANY (ARRAY['admin'::app_role,
                                 'supervisor_almacen'::app_role,
                                 'supervisor_operaciones'::app_role,
                                 'coordinador_operaciones'::app_role])
    )
  );

CREATE POLICY rq_tomas_delete_auth ON public.rq_atencion_tomas
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = ANY (ARRAY['admin'::app_role,
                                 'supervisor_almacen'::app_role,
                                 'supervisor_operaciones'::app_role,
                                 'coordinador_operaciones'::app_role])
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rq_atencion_tomas TO authenticated;
GRANT ALL ON public.rq_atencion_tomas TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2) HELPER rq_ubicacion_texto — etiqueta de posición con el MISMO formato
--    del app (transito-core.ts): B{bloque}·T{torre}·P{piso}·Pos{posicion}.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rq_ubicacion_texto(p_rack jsonb, p_piso jsonb, p_fallback text DEFAULT ''::text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_rack IS NOT NULL AND COALESCE(p_rack->>'bloque', '') <> '' THEN
      'B' || COALESCE(p_rack->>'bloque', '') || '·T' || COALESCE(p_rack->>'torre', '') ||
      '·P' || COALESCE(p_rack->>'piso', '') || '·Pos' || COALESCE(p_rack->>'posicion', '')
    WHEN p_piso IS NOT NULL AND COALESCE(p_piso->>'nivel_id', '') <> '' THEN
      COALESCE(NULLIF(TRIM(COALESCE(p_piso->>'etiqueta', '')), ''),
               'Piso · nivel ' || COALESCE(p_piso->>'nivel_numero', p_piso->>'nivel_id'))
    ELSE COALESCE(NULLIF(TRIM(COALESCE(p_fallback, '')), ''), '')
  END
$function$;

GRANT EXECUTE ON FUNCTION public.rq_ubicacion_texto(jsonb, jsonb, text) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3) rq_atender_item v10 — + p_toma jsonb OPCIONAL (al final: compatible).
--    Con posiciones: valida que sumen p_cantidad y registra una fila por
--    posición. Sin posiciones: registra una toma 'manual' (trazabilidad).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rq_atender_item(p_item_id uuid, p_cantidad numeric, p_usuario text, p_toma jsonb DEFAULT NULL)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_item rq_atencion_items%ROWTYPE;
  v_pendientes integer;
  v_alguno boolean;
  v_suma_tomas numeric;
begin
  -- v8 (auditoría 2026-10-23): guard de rol, consistente con rq_atender_lote.
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden atender materiales';
  END IF;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a atender debe ser mayor que cero';
  end if;

  -- v10 (Task 27): si vienen posiciones, su suma debe ser la cantidad atendida.
  if p_toma is not null then
    if jsonb_typeof(p_toma) <> 'array' then
      raise exception 'TOMA_INVALIDA|El detalle de posiciones debe ser un arreglo';
    end if;
    select coalesce(sum((t->>'cantidad')::numeric), 0) into v_suma_tomas
      from jsonb_array_elements(p_toma) t
      where coalesce((t->>'cantidad')::numeric, 0) > 0;
    if abs(coalesce(v_suma_tomas, 0) - p_cantidad) > 0.0001 then
      raise exception 'TOMA_INVALIDA|La suma de las posiciones (%) no coincide con lo atendido (%)',
        v_suma_tomas, p_cantidad;
    end if;
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

  -- v10 (Task 27): LEDGER de tomas para «Revisar». Con posiciones: una fila
  -- por posición; sin ellas: toma 'manual' (quién atendió y cuánto).
  if p_toma is not null and jsonb_array_length(p_toma) > 0 then
    insert into rq_atencion_tomas
      (rq_id, item_id, codigo, origen, cantidad, ubicacion, rack, piso, usuario_id, usuario_nombre, usuario_correo)
    select
      v_item.rq_id, v_item.id, v_item.codigo,
      case when coalesce(nullif(lower(trim(t->>'origen')), ''), '') in ('racks','piso','transito','manual')
           then lower(trim(t->>'origen')) else 'manual' end,
      (t->>'cantidad')::numeric,
      coalesce(rq_ubicacion_texto(t->'rack', t->'piso', t->>'ubicacion'), ''),
      t->'rack', t->'piso',
      auth.uid(), coalesce(p_usuario, ''), ''
    from jsonb_array_elements(p_toma) t
    where coalesce((t->>'cantidad')::numeric, 0) > 0;
  else
    insert into rq_atencion_tomas
      (rq_id, item_id, codigo, origen, cantidad, ubicacion, usuario_id, usuario_nombre, usuario_correo)
    values
      (v_item.rq_id, v_item.id, v_item.codigo, 'manual', p_cantidad, '', auth.uid(), coalesce(p_usuario, ''), '');
  end if;

  return to_json(v_item);
end $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4) rq_revertir_item v10 — la reversa queda en el ledger (cantidad −).
--    Lectura previa FOR UPDATE para registrar la cantidad REAL revertida.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rq_revertir_item(p_item_id uuid, p_cantidad numeric)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_item rq_atencion_items%ROWTYPE;
  v_antes numeric;
  v_revertido numeric;
  v_pendientes integer;
  v_alguno boolean;
  v_u record;
begin
  -- v8 (auditoría 2026-10-23): guard de rol + decremento ATÓMICO.
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden revertir atenciones';
  END IF;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a revertir debe ser mayor que cero';
  end if;

  -- v10 (Task 27): bloquea la fila y lee lo atendido ANTES del decremento.
  select cantidad_atendida into v_antes
    from rq_atencion_items where id = p_item_id for update;
  if not found then
    raise exception 'Artículo no encontrado';
  end if;

  update rq_atencion_items set
    cantidad_atendida = greatest(cantidad_atendida - p_cantidad, 0),
    atendido_en = case when greatest(cantidad_atendida - p_cantidad, 0) >= cantidad then atendido_en else null end
  where id = p_item_id
  returning * into v_item;

  -- v10: reversa REAL (p_cantidad podía exceder lo atendido) en el ledger.
  v_revertido := greatest(coalesce(v_antes, 0) - v_item.cantidad_atendida, 0);
  if v_revertido > 0 then
    select nombre, correo into v_u from profiles where id = auth.uid();
    insert into rq_atencion_tomas
      (rq_id, item_id, codigo, origen, cantidad, ubicacion, usuario_id, usuario_nombre, usuario_correo)
    values
      (v_item.rq_id, v_item.id, v_item.codigo, 'reversa', -v_revertido, '',
       auth.uid(), coalesce(v_u.nombre, ''), coalesce(v_u.correo, ''));
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

GRANT EXECUTE ON FUNCTION public.rq_atender_item(uuid, numeric, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rq_revertir_item(uuid, numeric) TO authenticated, service_role;

-- v10: el CREATE OR REPLACE con p_toma NUEVO creó un OVERLOAD (firma 4 args)
-- y la versión vieja de 3 args quedó viva → PostgREST resuelve por NOMBRES de
-- argumentos y con dos firmas compatibles devuelve 42725 "function is not
-- unique". Se elimina la vieja: la nueva cubre las llamadas de 3 args por el
-- DEFAULT de p_toma.
DROP FUNCTION IF EXISTS public.rq_atender_item(uuid, numeric, text);

-- ───────────────────────────────────────────────────────────────────────────
-- 5) rq_atender_lote v3 — cada toma del puente queda en el ledger, en la
--    MISMA transacción (si algo falla, ni envíos ni tomas quedan).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rq_atender_lote(p_item_id uuid, p_batch_uuid text, p_tomas jsonb, p_confirma_excedente boolean DEFAULT false, p_turno text DEFAULT ''::text, p_usuario_id uuid DEFAULT NULL::uuid, p_usuario_nombre text DEFAULT ''::text, p_usuario_correo text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item rq_atencion_items%ROWTYPE;
  v_rq rq_atenciones%ROWTYPE;
  v_toma jsonb;
  v_toma_uuid text;
  v_toma_actual text;
  v_ruta text;
  v_cant numeric;
  v_total numeric := 0;
  v_pendiente_rq numeric;
  v_recepcion_ids uuid[];
  v_rid uuid;
  v_row recepcion_registros%ROWTYPE;
  v_envios jsonb;
  v_enviados numeric;
  v_pendiente_fila numeric;
  v_codigo_item text;
  v_detalle jsonb := '[]'::jsonb;
  v_envio jsonb;
  v_res jsonb;
  v_bloque_piso_id uuid;
  v_nuevo numeric;
  v_pendientes integer;
  v_estado_rq text;
  v_sqlstate text;
  v_sqlerrm text;
  v_pipe integer;
  v_code text;
  v_msg text;
BEGIN
  -- Guard de autorización (misma política que transito_registrar_envio).
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar atenciones por lote';
  END IF;

  IF p_batch_uuid IS NULL OR TRIM(p_batch_uuid) = '' THEN
    RAISE EXCEPTION 'LOTE_INVALIDO|Falta el identificador único del lote';
  END IF;
  IF p_tomas IS NULL OR jsonb_typeof(p_tomas) <> 'array' OR jsonb_array_length(p_tomas) = 0 THEN
    RAISE EXCEPTION 'LOTE_VACIO|El lote no tiene tomas';
  END IF;

  -- Forma de cada toma: falla ruidosamente ANTES de bloquear nada.
  FOR v_toma IN SELECT * FROM jsonb_array_elements(p_tomas) LOOP
    v_toma_uuid := COALESCE(v_toma->>'uuid', '');
    v_ruta := COALESCE(v_toma->>'ruta', '');
    v_cant := COALESCE((v_toma->>'cantidad')::numeric, 0);
    IF TRIM(v_toma_uuid) = '' THEN
      RAISE EXCEPTION 'TOMA_INVALIDA|Hay tomas sin uuid';
    END IF;
    IF v_ruta NOT IN ('transito', 'posicion') THEN
      RAISE EXCEPTION 'TOMA_INVALIDA|Toma % con ruta inválida (%)', v_toma_uuid, v_ruta;
    END IF;
    IF v_cant <= 0 THEN
      RAISE EXCEPTION 'TOMA_INVALIDA|Toma % con cantidad inválida', v_toma_uuid;
    END IF;
    IF (v_toma->>'recepcion_id') IS NULL OR TRIM(v_toma->>'recepcion_id') = '' THEN
      RAISE EXCEPTION 'TOMA_INVALIDA|Toma % sin recepcion_id', v_toma_uuid;
    END IF;
    IF v_ruta = 'posicion'
       AND (v_toma->'rack' IS NULL OR COALESCE(v_toma->'rack'->>'bloque','') = '')
       AND (v_toma->'piso' IS NULL OR COALESCE(v_toma->'piso'->>'nivel_id','') = '') THEN
      RAISE EXCEPTION 'UBICACION_REQUERIDA|Toma % sin ubicación de posición', v_toma_uuid;
    END IF;
  END LOOP;

  -- Ítem de la RQ (bloqueado hasta el fin de la transacción).
  SELECT * INTO v_item FROM rq_atencion_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NO_EXISTE|El material de la RQ ya no existe';
  END IF;
  SELECT * INTO v_rq FROM rq_atenciones WHERE id = v_item.rq_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RQ_NO_EXISTE|La RQ del material ya no existe';
  END IF;
  v_codigo_item := UPPER(TRIM(v_item.codigo));

  BEGIN
    -- ═══ Bloque transaccional: cualquier fallo revoca TODO ═══

    -- Dedupe dentro del lote: la misma paleta (fila) dos veces = rechazo.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_tomas) AS t
      GROUP BY t->>'recepcion_id' HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'PALETA_DUPLICADA|El lote intenta atender dos veces la misma paleta/fila';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_tomas) AS t
      GROUP BY t->>'uuid' HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'TOMA_DUPLICADA|El lote repite el uuid de una toma';
    END IF;

    -- Excedente sin confirmar (la RQ permite sobreatención, pero explícita).
    SELECT COALESCE(SUM((t->>'cantidad')::numeric), 0) INTO v_total
      FROM jsonb_array_elements(p_tomas) AS t;
    v_pendiente_rq := GREATEST(v_item.cantidad - v_item.cantidad_atendida, 0);
    IF v_total > v_pendiente_rq AND NOT COALESCE(p_confirma_excedente, false) THEN
      RAISE EXCEPTION 'EXCEDENTE_SIN_CONFIRMAR|El lote atiende % pero el pendiente es %: confirma el excedente para continuar',
        v_total, v_pendiente_rq;
    END IF;

    -- Locks de recepción EN ORDEN (anti-deadlock) — MISMA clave que Tránsito.
    SELECT array_agg(DISTINCT (t->>'recepcion_id')::uuid ORDER BY (t->>'recepcion_id')::uuid)
      INTO v_recepcion_ids
      FROM jsonb_array_elements(p_tomas) AS t;
    FOREACH v_rid IN ARRAY v_recepcion_ids LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_rid::text, 7771));
    END LOOP;

    -- IDEMPOTENCIA del lote: si cualquier fila afectada ya trae este batch,
    -- el lote YA se registró → éxito sin tocar nada (reintento seguro).
    FOREACH v_rid IN ARRAY v_recepcion_ids LOOP
      SELECT transito -> 'envios' INTO v_envios FROM recepcion_registros WHERE id = v_rid;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_envios, '[]'::jsonb)) AS e
        WHERE e->>'lote' = TRIM(p_batch_uuid)
      ) THEN
        RETURN jsonb_build_object('ok', true, 'duplicado', true, 'total_atendido', 0);
      END IF;
    END LOOP;

    -- ── Tomas ruta TRÁNSITO: descuento de la guía ──
    FOR v_toma IN SELECT value FROM jsonb_array_elements(p_tomas) WHERE value->>'ruta' = 'transito' LOOP
      v_toma_uuid := v_toma->>'uuid';
      v_toma_actual := v_toma_uuid;
      v_cant := (v_toma->>'cantidad')::numeric;

      SELECT * INTO v_row FROM recepcion_registros WHERE id = (v_toma->>'recepcion_id')::uuid;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECEPCION_NO_EXISTE|Toma %: la fila de recepción ya no existe', v_toma_uuid;
      END IF;
      IF UPPER(TRIM(v_row.codigo)) <> v_codigo_item THEN
        RAISE EXCEPTION 'CODIGO_AJENO|Toma %: el código de la guía (%) no corresponde al material de la RQ (%)',
          v_toma_uuid, v_row.codigo, v_item.codigo;
      END IF;

      v_envios := COALESCE(v_row.transito -> 'envios', '[]'::jsonb);
      SELECT COALESCE(SUM((e->>'cantidad')::numeric), 0) INTO v_enviados
        FROM jsonb_array_elements(v_envios) AS e;
      v_pendiente_fila := v_row.cantidad - v_enviados;
      IF v_cant > v_pendiente_fila THEN
        RAISE EXCEPTION 'OVER_ISSUE_TRANSITO|Toma %: pide % pero la guía solo tiene % en tránsito',
          v_toma_uuid, v_cant, v_pendiente_fila;
      END IF;

      v_envio := jsonb_build_object(
        'uuid', v_toma_uuid,
        'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
        'destino', 'atencion',
        'ubicacion', '',
        'cantidad', v_cant,
        'usuario_id', p_usuario_id,
        'usuario_nombre', p_usuario_nombre,
        'turno', p_turno,
        'rack', NULL,
        'piso', NULL,
        'rq', v_rq.numero_rq,
        'item_id', p_item_id,
        'lote', TRIM(p_batch_uuid)
      );
      UPDATE recepcion_registros
        SET transito = jsonb_build_object('v', 1, 'envios', (v_envios || jsonb_build_array(v_envio)))
        WHERE id = v_row.id;

      -- v3 (Task 27): la toma queda en el ledger.
      INSERT INTO rq_atencion_tomas
        (rq_id, item_id, codigo, origen, cantidad, ubicacion, lote, usuario_id, usuario_nombre, usuario_correo, turno)
      VALUES
        (v_item.rq_id, p_item_id, v_codigo_item, 'transito', v_cant, '', TRIM(p_batch_uuid),
         p_usuario_id, p_usuario_nombre, p_usuario_correo, p_turno);

      v_detalle := v_detalle || jsonb_build_array(jsonb_build_object(
        'uuid', v_toma_uuid, 'recepcion_id', v_row.id, 'ruta', 'transito',
        'cantidad', v_cant, 'nuevo_pendiente', v_pendiente_fila - v_cant
      ));
    END LOOP;

    -- ── Tomas ruta POSICIÓN: salida real de la ubicación ──
    FOR v_toma IN SELECT value FROM jsonb_array_elements(p_tomas) WHERE value->>'ruta' = 'posicion' LOOP
      v_toma_uuid := v_toma->>'uuid';
      v_toma_actual := v_toma_uuid;
      v_cant := (v_toma->>'cantidad')::numeric;

      SELECT * INTO v_row FROM recepcion_registros WHERE id = (v_toma->>'recepcion_id')::uuid;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECEPCION_NO_EXISTE|Toma %: la fila de recepción ya no existe', v_toma_uuid;
      END IF;
      IF UPPER(TRIM(v_row.codigo)) <> v_codigo_item THEN
        RAISE EXCEPTION 'CODIGO_AJENO|Toma %: el código de la guía (%) no corresponde al material de la RQ (%)',
          v_toma_uuid, v_row.codigo, v_item.codigo;
      END IF;

      IF v_toma->'rack' IS NOT NULL AND COALESCE(v_toma->'rack'->>'bloque', '') <> '' THEN
        -- Salida NATIVA de Racks (valida saldo INSUFFICIENT_STOCK + FEFO + lock propio).
        v_res := public.registrar_movimiento_kardex(
          'salida',
          v_toma->'rack'->>'bloque', v_toma->'rack'->>'torre', v_toma->'rack'->>'piso', v_toma->'rack'->>'posicion',
          v_codigo_item, v_row.descripcion, v_row.unidad_medida, v_cant,
          v_row.fecha_vencimiento, p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo,
          v_row.proveedor, v_toma_uuid, NULL, NULLIF(TRIM(COALESCE(v_row.lote, '')), '')
        );
        v_envio := jsonb_build_object(
          'uuid', v_toma_uuid,
          'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
          'destino', 'atencion_posicion',
          'ubicacion', COALESCE(v_toma->>'ubicacion', ''),
          'cantidad', 0,
          'cantidad_atencion', v_cant,
          'usuario_id', p_usuario_id,
          'usuario_nombre', p_usuario_nombre,
          'turno', p_turno,
          'rack', v_toma->'rack',
          'piso', NULL,
          'rq', v_rq.numero_rq,
          'item_id', p_item_id,
          'lote', TRIM(p_batch_uuid),
          'saldo_resultante', COALESCE(v_res->>'new_stock', '')
        );
        -- v3 (Task 27): la toma queda en el ledger CON el saldo resultante.
        INSERT INTO rq_atencion_tomas
          (rq_id, item_id, codigo, origen, cantidad, ubicacion, saldo_resultante, rack, lote, usuario_id, usuario_nombre, usuario_correo, turno)
        VALUES
          (v_item.rq_id, p_item_id, v_codigo_item, 'racks', v_cant,
           rq_ubicacion_texto(v_toma->'rack', NULL, v_toma->>'ubicacion'),
           NULLIF(COALESCE(v_res->>'new_stock', ''), '')::numeric,
           v_toma->'rack', TRIM(p_batch_uuid), p_usuario_id, p_usuario_nombre, p_usuario_correo, p_turno);
      ELSIF v_toma->'piso' IS NOT NULL AND COALESCE(v_toma->'piso'->>'nivel_id', '') <> '' THEN
        SELECT id INTO v_bloque_piso_id FROM piso_bloques WHERE codigo = v_codigo_item;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'BLOQUE_PISO_NO_EXISTE|Toma %: no existe bloque Piso para el código %', v_toma_uuid, v_item.codigo;
        END IF;
        -- Salida NATIVA de Piso (valida stock por nivel + locks propios).
        v_res := public.piso_registrar_salida(
          p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo, v_toma_uuid,
          jsonb_build_array(jsonb_build_object(
            'nivel_id', v_toma->'piso'->>'nivel_id',
            'bloque_id', v_bloque_piso_id,
            'cantidad', v_cant,
            'fecha_vencimiento', COALESCE(to_char(v_row.fecha_vencimiento, 'YYYY-MM-DD'), '')
          ))
        );
        v_envio := jsonb_build_object(
          'uuid', v_toma_uuid,
          'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
          'destino', 'atencion_posicion',
          'ubicacion', COALESCE(v_toma->>'ubicacion', ''),
          'cantidad', 0,
          'cantidad_atencion', v_cant,
          'usuario_id', p_usuario_id,
          'usuario_nombre', p_usuario_nombre,
          'turno', p_turno,
          'rack', NULL,
          'piso', v_toma->'piso',
          'rq', v_rq.numero_rq,
          'item_id', p_item_id,
          'lote', TRIM(p_batch_uuid)
        );
        -- v3 (Task 27): la toma queda en el ledger (Piso no reporta saldo).
        INSERT INTO rq_atencion_tomas
          (rq_id, item_id, codigo, origen, cantidad, ubicacion, piso, lote, usuario_id, usuario_nombre, usuario_correo, turno)
        VALUES
          (v_item.rq_id, p_item_id, v_codigo_item, 'piso', v_cant,
           rq_ubicacion_texto(NULL, v_toma->'piso', v_toma->>'ubicacion'),
           v_toma->'piso', TRIM(p_batch_uuid), p_usuario_id, p_usuario_nombre, p_usuario_correo, p_turno);
      ELSE
        RAISE EXCEPTION 'UBICACION_REQUERIDA|Toma % sin ubicación de posición', v_toma_uuid;
      END IF;

      UPDATE recepcion_registros
        SET transito = jsonb_build_object(
              'v', 1,
              'envios', (COALESCE(transito->'envios', '[]'::jsonb) || jsonb_build_array(v_envio)))
        WHERE id = v_row.id;

      v_detalle := v_detalle || jsonb_build_array(jsonb_build_object(
        'uuid', v_toma_uuid, 'recepcion_id', v_row.id, 'ruta', 'posicion',
        'cantidad', v_cant
      ));
    END LOOP;

    -- ── Ítem RQ: UNA sola actualización + estado del encabezado ──
    v_nuevo := v_item.cantidad_atendida + v_total;
    UPDATE rq_atencion_items SET
      cantidad_atendida = v_nuevo,
      usuario_atencion = COALESCE(NULLIF(p_usuario_nombre, ''), v_item.usuario_atencion),
      atendido_en = CASE WHEN v_nuevo >= v_item.cantidad THEN now() ELSE NULL END
    WHERE id = p_item_id;

    SELECT COUNT(*) INTO v_pendientes
      FROM rq_atencion_items
      WHERE rq_id = v_item.rq_id AND cantidad_atendida < cantidad;
    v_estado_rq := CASE WHEN v_pendientes = 0 THEN 'Atendido' ELSE 'En proceso' END;
    UPDATE rq_atenciones SET estado = v_estado_rq WHERE id = v_item.rq_id;

    RETURN jsonb_build_object(
      'ok', true,
      'duplicado', false,
      'total_atendido', v_total,
      'tomas_ok', jsonb_array_length(v_detalle),
      'nuevo_atendido', v_nuevo,
      'pendiente_rq', GREATEST(v_item.cantidad - v_nuevo, 0),
      'estado_rq', v_estado_rq,
      'detalle', v_detalle
    );

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_sqlerrm = MESSAGE_TEXT;
    v_pipe := position('|' in v_sqlerrm);
    IF v_pipe > 1 THEN
      v_code := substring(v_sqlerrm from 1 for v_pipe - 1);
      v_msg := substring(v_sqlerrm from v_pipe + 1);
    ELSE
      v_code := v_sqlstate;
      v_msg := v_sqlerrm;
    END IF;
    RETURN jsonb_build_object('ok', false, 'fallo', jsonb_build_object(
      'codigo', v_code,
      'mensaje', v_msg,
      'toma', v_toma_actual
    ));
  END;
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6) rq_revertir_origen v3 — cada reversa del puente queda en el ledger
--    (cantidad −, misma ubicación de la toma original).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rq_revertir_origen(p_item_id uuid, p_batch_uuid text DEFAULT NULL::text, p_turno text DEFAULT ''::text, p_usuario_id uuid DEFAULT NULL::uuid, p_usuario_nombre text DEFAULT ''::text, p_usuario_correo text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item rq_atencion_items%ROWTYPE;
  v_rq rq_atenciones%ROWTYPE;
  v_codigo_item text;
  v_fila record;
  v_envio jsonb;
  v_toma_uuid text;
  v_toma_actual text;
  v_reversa_de text;
  v_ruta text;
  v_cant numeric;
  v_total_revertido numeric := 0;
  v_tomas_revertidas integer := 0;
  v_envios jsonb;
  v_nuevo_envio jsonb;
  v_uuid_reversa text;
  v_lote_reversa text;
  v_bloque_piso_id uuid;
  v_mov_id uuid;
  v_rid uuid;
  v_ids_recepcion uuid[];
  v_nuevo numeric;
  v_pendientes integer;
  v_total_items integer;
  v_estado_rq text;
  v_res jsonb;
  v_sqlstate text;
  v_sqlerrm text;
  v_pipe integer;
  v_code text;
  v_msg text;
  v_candidatas integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden revertir atenciones con origen';
  END IF;

  SELECT * INTO v_item FROM rq_atencion_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NO_EXISTE|El material de la RQ ya no existe';
  END IF;
  SELECT * INTO v_rq FROM rq_atenciones WHERE id = v_item.rq_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RQ_NO_EXISTE|La RQ del material ya no existe';
  END IF;
  v_codigo_item := UPPER(TRIM(v_item.codigo));

  BEGIN
    -- Filas afectadas: las guías del código cuyo jsonb trae tomas de ESTE item
    -- (y del batch pedido, si viene) usando contención jsonb del arreglo.
    IF p_batch_uuid IS NOT NULL AND TRIM(p_batch_uuid) <> '' THEN
      SELECT array_agg(DISTINCT r.id ORDER BY r.id) INTO v_ids_recepcion
        FROM recepcion_registros r
        WHERE UPPER(TRIM(r.codigo)) = v_codigo_item
          AND r.transito->'envios' @> jsonb_build_array(
                jsonb_build_object('lote', TRIM(p_batch_uuid), 'item_id', p_item_id));
    ELSE
      SELECT array_agg(DISTINCT r.id ORDER BY r.id) INTO v_ids_recepcion
        FROM recepcion_registros r
        WHERE UPPER(TRIM(r.codigo)) = v_codigo_item
          AND r.transito->'envios' @> jsonb_build_array(jsonb_build_object('item_id', p_item_id));
    END IF;

    IF v_ids_recepcion IS NULL OR array_length(v_ids_recepcion, 1) IS NULL THEN
      RAISE EXCEPTION 'LOTE_NO_ENCONTRADO|No hay atenciones del puente registradas para este material';
    END IF;

    FOREACH v_rid IN ARRAY v_ids_recepcion LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_rid::text, 7771));
    END LOOP;

    FOREACH v_rid IN ARRAY v_ids_recepcion LOOP
      SELECT * INTO v_fila FROM recepcion_registros WHERE id = v_rid;
      SELECT transito->'envios' INTO v_envios FROM recepcion_registros WHERE id = v_rid;

      FOR v_envio IN SELECT value FROM jsonb_array_elements(COALESCE(v_envios, '[]'::jsonb)) LOOP
        -- Solo tomas de ESTE item (y del batch pedido si vino).
        IF COALESCE(v_envio->>'item_id', '') <> p_item_id::text THEN CONTINUE; END IF;
        IF p_batch_uuid IS NOT NULL AND TRIM(p_batch_uuid) <> ''
           AND COALESCE(v_envio->>'lote', '') <> TRIM(p_batch_uuid) THEN CONTINUE; END IF;
        -- Solo tomas ATENDIDAS (no las reversas ya existentes).
        v_ruta := COALESCE(v_envio->>'destino', '');
        IF v_ruta NOT IN ('atencion', 'atencion_posicion') THEN CONTINUE; END IF;
        IF COALESCE(v_envio->>'reversa_de', '') <> '' THEN CONTINUE; END IF;

        v_toma_uuid := COALESCE(v_envio->>'uuid', '');
        v_candidatas := v_candidatas + 1;
        -- Idempotencia POR TOMA: si esta toma ya tiene su reversa, saltarla
        -- (permite revertir lotes distintos por separado sin falsos duplicados).
        IF EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_envios) AS r
          WHERE r->>'reversa_de' = v_toma_uuid
        ) THEN
          CONTINUE;
        END IF;
        v_toma_actual := v_toma_uuid;
        v_reversa_de := v_toma_uuid;
        v_uuid_reversa := gen_random_uuid()::text;
        v_lote_reversa := 'REV-' || COALESCE(COALESCE(v_envio->>'lote', v_toma_uuid), '');

        IF v_ruta = 'atencion' THEN
          -- Ruta TRÁNSITO: compensación negativa → el pendiente de la guía vuelve.
          v_cant := COALESCE((v_envio->>'cantidad')::numeric, 0);
          v_total_revertido := v_total_revertido + v_cant;
          v_nuevo_envio := jsonb_build_object(
            'uuid', v_uuid_reversa,
            'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
            'destino', 'reversa_atencion',
            'ubicacion', '',
            'cantidad', -v_cant,
            'usuario_id', p_usuario_id,
            'usuario_nombre', p_usuario_nombre,
            'turno', p_turno,
            'rack', NULL,
            'piso', NULL,
            'rq', v_rq.numero_rq,
            'item_id', p_item_id,
            'lote', v_lote_reversa,
            'reversa_de', v_reversa_de
          );
        ELSE
          -- Ruta POSICIÓN: INGRESO compensatorio en la MISMA ubicación con el
          -- lote de la fila de Recepción (cantidad exacta de la toma).
          v_cant := COALESCE((v_envio->>'cantidad_atencion')::numeric, 0);
          v_total_revertido := v_total_revertido + v_cant;
          IF v_envio->'rack' IS NOT NULL AND COALESCE(v_envio->'rack'->>'bloque', '') <> '' THEN
            v_res := public.registrar_movimiento_kardex(
              'ingreso',
              v_envio->'rack'->>'bloque', v_envio->'rack'->>'torre', v_envio->'rack'->>'piso', v_envio->'rack'->>'posicion',
              v_codigo_item, v_fila.descripcion, v_fila.unidad_medida, v_cant,
              v_fila.fecha_vencimiento, p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo,
              v_fila.proveedor, v_uuid_reversa, NULL, NULLIF(TRIM(COALESCE(v_fila.lote, '')), '')
            );
          ELSIF v_envio->'piso' IS NOT NULL AND COALESCE(v_envio->'piso'->>'nivel_id', '') <> '' THEN
            SELECT id INTO v_bloque_piso_id FROM piso_bloques WHERE codigo = v_codigo_item;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'BLOQUE_PISO_NO_EXISTE|Toma %: no existe bloque Piso para el código %', v_toma_uuid, v_item.codigo;
            END IF;
            INSERT INTO piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, posicion_id)
            VALUES ('ingreso', p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo, v_uuid_reversa,
                    NULLIF(v_envio->'piso'->>'posicion_id', '')::uuid)
            RETURNING id INTO v_mov_id;
            INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
            VALUES (v_mov_id, (v_envio->'piso'->>'nivel_id')::uuid, v_bloque_piso_id, v_cant,
                    v_fila.fecha_vencimiento, NULLIF(TRIM(COALESCE(v_fila.lote, '')), ''));
          ELSE
            RAISE EXCEPTION 'UBICACION_REQUERIDA|Toma % sin ubicación para reingresar', v_toma_uuid;
          END IF;
          v_nuevo_envio := jsonb_build_object(
            'uuid', v_uuid_reversa,
            'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
            'destino', 'reversa_atencion',
            'ubicacion', COALESCE(v_envio->>'ubicacion', ''),
            'cantidad', 0,
            'cantidad_atencion', -v_cant,
            'usuario_id', p_usuario_id,
            'usuario_nombre', p_usuario_nombre,
            'turno', p_turno,
            'rack', v_envio->'rack',
            'piso', v_envio->'piso',
            'rq', v_rq.numero_rq,
            'item_id', p_item_id,
            'lote', v_lote_reversa,
            'reversa_de', v_reversa_de
          );
        END IF;

        UPDATE recepcion_registros
          SET transito = jsonb_build_object(
                'v', 1,
                'envios', (COALESCE(transito->'envios', '[]'::jsonb) || jsonb_build_array(v_nuevo_envio)))
          WHERE id = v_rid;

        -- v3 (Task 27): la reversa queda en el ledger (cantidad −).
        INSERT INTO rq_atencion_tomas
          (rq_id, item_id, codigo, origen, cantidad, ubicacion, rack, piso, lote, usuario_id, usuario_nombre, usuario_correo, turno)
        VALUES
          (v_item.rq_id, p_item_id, v_codigo_item, 'reversa', -v_cant,
           rq_ubicacion_texto(v_envio->'rack', v_envio->'piso', v_envio->>'ubicacion'),
           v_envio->'rack', v_envio->'piso', v_lote_reversa,
           p_usuario_id, p_usuario_nombre, p_usuario_correo, p_turno);

        v_tomas_revertidas := v_tomas_revertidas + 1;
      END LOOP;
    END LOOP;

    IF v_tomas_revertidas = 0 THEN
      IF v_candidatas > 0 THEN
        -- Todas las tomas candidatas ya estaban revertidas → éxito idempotente.
        RETURN jsonb_build_object('ok', true, 'duplicado', true, 'total_revertido', 0);
      END IF;
      RAISE EXCEPTION 'LOTE_NO_ENCONTRADO|No se encontró ninguna toma activa para revertir';
    END IF;

    -- Ítem: devolver lo atendido (piso 0) + estado del encabezado (3 vías).
    v_nuevo := GREATEST(v_item.cantidad_atendida - v_total_revertido, 0);
    UPDATE rq_atencion_items SET
      cantidad_atendida = v_nuevo,
      atendido_en = CASE WHEN v_nuevo >= v_item.cantidad THEN v_item.atendido_en ELSE NULL END
    WHERE id = p_item_id;

    SELECT COUNT(*) INTO v_pendientes
      FROM rq_atencion_items WHERE rq_id = v_item.rq_id AND cantidad_atendida < cantidad;
    SELECT COUNT(*) INTO v_total_items FROM rq_atencion_items WHERE rq_id = v_item.rq_id;
    v_estado_rq := CASE
      WHEN v_pendientes = 0 THEN 'Atendido'
      WHEN v_pendientes = v_total_items THEN 'Pendiente'
      ELSE 'En proceso' END;
    UPDATE rq_atenciones SET estado = v_estado_rq WHERE id = v_item.rq_id;

    RETURN jsonb_build_object(
      'ok', true,
      'duplicado', false,
      'total_revertido', v_total_revertido,
      'tomas_revertidas', v_tomas_revertidas,
      'nuevo_atendido', v_nuevo,
      'estado_rq', v_estado_rq
    );

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_sqlerrm = MESSAGE_TEXT;
    v_pipe := position('|' in v_sqlerrm);
    IF v_pipe > 1 THEN
      v_code := substring(v_sqlerrm from 1 for v_pipe - 1);
      v_msg := substring(v_sqlerrm from v_pipe + 1);
    ELSE
      v_code := v_sqlstate;
      v_msg := v_sqlerrm;
    END IF;
    RETURN jsonb_build_object('ok', false, 'fallo', jsonb_build_object(
      'codigo', v_code, 'mensaje', v_msg, 'toma', v_toma_actual
    ));
  END;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.rq_atender_lote(uuid, text, jsonb, boolean, text, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rq_revertir_origen(uuid, text, text, uuid, text, text) TO authenticated, service_role;
