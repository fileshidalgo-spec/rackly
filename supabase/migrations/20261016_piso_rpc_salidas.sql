-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — RPC de SALIDAS Piso + hardening del módulo Piso (2026-10-16)
--
-- QUÉ RESUELVE (diagnóstico de la auditoría RPC de salidas Piso):
--   R1. La app registraba salidas/traslados con INSERT multi-paso del cliente
--       (cabecera → detalles + rollback manual) → 87 cabeceras huérfanas
--       reales cuando el paso 2 fallaba. Las RPC de BD existían pero estaban
--       DESACTUALIZADAS: sin columna `lote`, numero_operacion por MAX+1
--       (carrera contra la secuencia usada por el cliente → duplicados),
--       lock global con try_lock (falla bajo concurrencia en vez de esperar),
--       y filtro codigo_inc contradictorio con la aritmética de la app.
--   R2. rpc piso_stock_detalle_posicion con FEFO puro (descuenta salidas
--       ignorando la fecha del lote elegido) — inutilizada por la app,
--       que calcula client-side. Se alinea al algoritmo DIRIGIDO.
--   R3. Funciones SECURITY DEFINER de ESCRITURA ejecutables por el rol anónimo
--       (mismo agujero P1 que la auditoría 2026-10-16 corrigió SOLO en
--       transito_registrar_envio): piso_registrar_salida, piso_registrar_traslado,
--       rackly_reemplazar_movimientos, registrar_movimiento_kardex,
--       registrar_traslado_kardex (+ lectores secdef sin razón para anon).
--
-- SEMÁNTICA DE STOCK (alineada 1:1 con la app — validarStockSuficiente):
--   neto(nivel, bloque) = Σ(ingreso|devolucion|stock_inicial) − Σ(salida)
--   SIN filtrar codigo_inc (la app lo incluye en el neto y lo usa como
--   etiqueta del lote, no como libro separado).
--
-- SEGURO:
--   · Idempotente: re-ejecutable sin daño (CREATE OR REPLACE, IF NOT EXISTS).
--   · No toca datos (sin INSERT/UPDATE/DELETE de filas de usuario).
--   · numero_operacion: las RPC dejan de fijarlo → usan la SECUENCIA
--     (única fuente de verdad; se añade índice UNIQUE defensivo).
--   · La app anterior (bundle vivo) NO llama a ninguna de estas RPC
--     (registrarSalidaPosicion/Traslado usan INSERT directo) → cero riesgo
--     de regresión para el despliegue en curso.
--
-- DÓNDE: Supabase Dashboard → SQL Editor, o Management API /database/query.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. piso_salida_posicion — SALIDA ATÓMICA (validación + cabecera + detalles
--    en UNA transacción, locks por nivel que ESPERAN, lote, secuencia).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.piso_salida_posicion(
  p_turno          text,
  p_usuario_id     text,
  p_usuario_nombre text,
  p_usuario_correo text,
  p_uuid_sync      text DEFAULT NULL::text,
  p_detalles       jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_mov_id          uuid;
  v_num_out         bigint;
  v_detalle         jsonb;
  v_nivel_id        uuid;
  v_bloque_id       uuid;
  v_cant_solicitada numeric;
  v_stock_actual    numeric;
  v_bloque_codigo   text;
  v_txt             text;
  v_fecha           date;
BEGIN
  -- Guard (defensa en profundidad; RLS ya bloquea a anon)
  IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar salidas';
  END IF;

  IF p_detalles IS NULL OR jsonb_array_length(p_detalles) = 0 THEN
    RAISE EXCEPTION 'DETALLES_VACIOS|La salida no tiene artículos';
  END IF;

  -- Idempotencia: mismo uuid_sync → ya registrado
  IF p_uuid_sync IS NOT NULL AND p_uuid_sync <> '' THEN
    SELECT id INTO v_mov_id FROM piso_movimientos WHERE uuid_sync = p_uuid_sync LIMIT 1;
    IF v_mov_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'id', v_mov_id, 'idempotent', true);
    END IF;
  END IF;

  -- Locks por nivel (bloqueantes; orden determinista evita deadlocks entre
  -- traslados concurrentes). Ya no try_lock global: bajo concurrencia se
  -- ENCOLA en vez de fallar con "Otra operación está en curso".
  FOR v_nivel_id IN
    SELECT DISTINCT (d->>'nivel_id')::uuid
    FROM jsonb_array_elements(p_detalles) AS d
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_nivel_id::text, 0));
  END LOOP;

  -- Validación de stock contra la BD real (misma aritmética que la app,
  -- tolerancia de redondeo a 3 decimales). Dentro de los locks: sin TOCTOU.
  FOR v_nivel_id, v_bloque_id, v_cant_solicitada IN
    SELECT (d->>'nivel_id')::uuid,
           (d->>'bloque_id')::uuid,
           COALESCE(SUM((d->>'cantidad')::numeric), 0)
    FROM jsonb_array_elements(p_detalles) AS d
    GROUP BY 1, 2
  LOOP
    IF v_cant_solicitada <= 0 THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA|Todas las cantidades deben ser mayores a 0';
    END IF;

    SELECT COALESCE(SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','stock_inicial') THEN md.cantidad ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN m.tipo = 'salida' THEN md.cantidad ELSE 0 END), 0)
      INTO v_stock_actual
      FROM piso_movimiento_detalles md
      JOIN piso_movimientos m ON m.id = md.movimiento_id
     WHERE md.nivel_id = v_nivel_id
       AND md.bloque_id = v_bloque_id;

    SELECT codigo INTO v_bloque_codigo FROM piso_bloques WHERE id = v_bloque_id;

    IF round(v_cant_solicitada, 3) > round(COALESCE(v_stock_actual, 0), 3) + 1e-9 THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK|Stock insuficiente para %: solicita %, disponible %',
        COALESCE(v_bloque_codigo, 'bloque'),
        round(v_cant_solicitada, 3),
        round(COALESCE(v_stock_actual, 0), 3);
    END IF;
  END LOOP;

  -- Cabecera: numero_operacion lo asigna la SECUENCIA (columna default);
  -- se elimina el MAX+1 que competía con la secuencia del cliente.
  INSERT INTO piso_movimientos (tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('salida', now(), p_turno, NULLIF(btrim(p_usuario_id), '')::uuid, p_usuario_nombre, p_usuario_correo, p_uuid_sync)
  RETURNING id, numero_operacion INTO v_mov_id, v_num_out;

  -- Detalles: con lote físico y parseo de fecha tolerante (ISO o timestamp)
  FOR v_detalle IN SELECT * FROM jsonb_array_elements(p_detalles)
  LOOP
    v_txt   := v_detalle->>'fecha_vencimiento';
    v_fecha := NULL;
    IF v_txt IS NOT NULL AND v_txt <> '' AND v_txt <> 'null' THEN
      BEGIN
        v_fecha := to_date(v_txt, 'YYYY-MM-DD');
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          v_fecha := v_txt::timestamptz::date;
        EXCEPTION WHEN OTHERS THEN
          v_fecha := NULL;
        END;
      END;
    END IF;

    INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    VALUES (
      v_mov_id,
      (v_detalle->>'nivel_id')::uuid,
      (v_detalle->>'bloque_id')::uuid,
      COALESCE((v_detalle->>'cantidad')::numeric, 0),
      v_fecha,
      NULLIF(btrim(COALESCE(v_detalle->>'lote', '')), '')
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'id', v_mov_id, 'numero_operacion', v_num_out);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. piso_traslado_posicion — TRASLADO ATÓMICO (salida + ingreso en la MISMA
--    transacción; limpieza de parciales residuales; lote propagado).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.piso_traslado_posicion(
  p_turno            text,
  p_usuario_id       text,
  p_usuario_nombre   text,
  p_usuario_correo   text,
  p_uuid_sync        text DEFAULT NULL::text,
  p_detalles_salida  jsonb DEFAULT '[]'::jsonb,
  p_detalles_ingreso jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_sal_id          uuid;
  v_ing_id          uuid;
  v_num_sal         bigint;
  v_num_ing         bigint;
  v_detalle         jsonb;
  v_nivel_id        uuid;
  v_bloque_id       uuid;
  v_cant_solicitada numeric;
  v_stock_actual    numeric;
  v_bloque_codigo   text;
  v_total_sal       numeric;
  v_total_ing       numeric;
  v_existentes      int;
  v_txt             text;
  v_fecha           date;
BEGIN
  IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar traslados';
  END IF;

  IF p_detalles_salida IS NULL OR jsonb_array_length(p_detalles_salida) = 0
     OR p_detalles_ingreso IS NULL OR jsonb_array_length(p_detalles_ingreso) = 0 THEN
    RAISE EXCEPTION 'DETALLES_VACIOS|El traslado requiere artículos de salida y de ingreso';
  END IF;

  -- Idempotencia: 2 cabeceras con el mismo uuid_sync → ya registrado.
  -- 1 sola cabecera = traslado PARCIAL de un intento previo: se limpia y se
  -- rehace completo aquí (antes el reintento creaba un TERCER movimiento).
  IF p_uuid_sync IS NOT NULL AND p_uuid_sync <> '' THEN
    SELECT count(*) INTO v_existentes FROM piso_movimientos WHERE uuid_sync = p_uuid_sync;
    IF v_existentes >= 2 THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true);
    END IF;
    IF v_existentes = 1 THEN
      DELETE FROM piso_movimiento_detalles
       WHERE movimiento_id IN (SELECT id FROM piso_movimientos WHERE uuid_sync = p_uuid_sync);
      DELETE FROM piso_movimientos WHERE uuid_sync = p_uuid_sync;
    END IF;
  END IF;

  -- Verificación de saldos: salida total = ingreso total
  SELECT COALESCE(SUM((e->>'cantidad')::numeric), 0) INTO v_total_sal
    FROM jsonb_array_elements(p_detalles_salida) AS e;
  SELECT COALESCE(SUM((e->>'cantidad')::numeric), 0) INTO v_total_ing
    FROM jsonb_array_elements(p_detalles_ingreso) AS e;
  IF round(v_total_sal, 3) <> round(v_total_ing, 3) THEN
    RAISE EXCEPTION 'MISMATCH_QUANTITY|La cantidad total de salida (%) no coincide con la de ingreso (%)',
      round(v_total_sal, 3), round(v_total_ing, 3);
  END IF;

  -- Locks por nivel de AMBAS listas (origen y destino), orden determinista
  FOR v_nivel_id IN
    SELECT DISTINCT nid FROM (
      SELECT (d->>'nivel_id')::uuid AS nid FROM jsonb_array_elements(p_detalles_salida) AS d
      UNION
      SELECT (d->>'nivel_id')::uuid AS nid FROM jsonb_array_elements(p_detalles_ingreso) AS d
    ) sub
    ORDER BY nid
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_nivel_id::text, 0));
  END LOOP;

  -- Validación de stock del ORIGEN (misma aritmética que la app)
  FOR v_nivel_id, v_bloque_id, v_cant_solicitada IN
    SELECT (d->>'nivel_id')::uuid,
           (d->>'bloque_id')::uuid,
           COALESCE(SUM((d->>'cantidad')::numeric), 0)
    FROM jsonb_array_elements(p_detalles_salida) AS d
    GROUP BY 1, 2
  LOOP
    IF v_cant_solicitada <= 0 THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA|Todas las cantidades deben ser mayores a 0';
    END IF;

    SELECT COALESCE(SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','stock_inicial') THEN md.cantidad ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN m.tipo = 'salida' THEN md.cantidad ELSE 0 END), 0)
      INTO v_stock_actual
      FROM piso_movimiento_detalles md
      JOIN piso_movimientos m ON m.id = md.movimiento_id
     WHERE md.nivel_id = v_nivel_id
       AND md.bloque_id = v_bloque_id;

    SELECT codigo INTO v_bloque_codigo FROM piso_bloques WHERE id = v_bloque_id;

    IF round(v_cant_solicitada, 3) > round(COALESCE(v_stock_actual, 0), 3) + 1e-9 THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK|Traslado: stock insuficiente para % en origen: solicita %, disponible %',
        COALESCE(v_bloque_codigo, 'bloque'),
        round(v_cant_solicitada, 3),
        round(COALESCE(v_stock_actual, 0), 3);
    END IF;
  END LOOP;

  -- Cabeceras salida + ingreso (numero_operacion por SECUENCIA en ambas)
  INSERT INTO piso_movimientos (tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('salida', now(), p_turno, NULLIF(btrim(p_usuario_id), '')::uuid, p_usuario_nombre, p_usuario_correo, p_uuid_sync)
  RETURNING id, numero_operacion INTO v_sal_id, v_num_sal;

  INSERT INTO piso_movimientos (tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('ingreso', now(), p_turno, NULLIF(btrim(p_usuario_id), '')::uuid, p_usuario_nombre, p_usuario_correo, p_uuid_sync)
  RETURNING id, numero_operacion INTO v_ing_id, v_num_ing;

  -- Detalles de SALIDA (con lote y fecha tolerante)
  FOR v_detalle IN SELECT * FROM jsonb_array_elements(p_detalles_salida)
  LOOP
    v_txt   := v_detalle->>'fecha_vencimiento';
    v_fecha := NULL;
    IF v_txt IS NOT NULL AND v_txt <> '' AND v_txt <> 'null' THEN
      BEGIN
        v_fecha := to_date(v_txt, 'YYYY-MM-DD');
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          v_fecha := v_txt::timestamptz::date;
        EXCEPTION WHEN OTHERS THEN
          v_fecha := NULL;
        END;
      END;
    END IF;

    INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    VALUES (v_sal_id,
            (v_detalle->>'nivel_id')::uuid,
            (v_detalle->>'bloque_id')::uuid,
            COALESCE((v_detalle->>'cantidad')::numeric, 0),
            v_fecha,
            NULLIF(btrim(COALESCE(v_detalle->>'lote', '')), ''));
  END LOOP;

  -- Detalles de INGRESO (destino; el lote viaja con la mercadería)
  FOR v_detalle IN SELECT * FROM jsonb_array_elements(p_detalles_ingreso)
  LOOP
    v_txt   := v_detalle->>'fecha_vencimiento';
    v_fecha := NULL;
    IF v_txt IS NOT NULL AND v_txt <> '' AND v_txt <> 'null' THEN
      BEGIN
        v_fecha := to_date(v_txt, 'YYYY-MM-DD');
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          v_fecha := v_txt::timestamptz::date;
        EXCEPTION WHEN OTHERS THEN
          v_fecha := NULL;
        END;
      END;
    END IF;

    INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    VALUES (v_ing_id,
            (v_detalle->>'nivel_id')::uuid,
            (v_detalle->>'bloque_id')::uuid,
            COALESCE((v_detalle->>'cantidad')::numeric, 0),
            v_fecha,
            NULLIF(btrim(COALESCE(v_detalle->>'lote', '')), ''));
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'salida_id', v_sal_id,
    'ingreso_id', v_ing_id,
    'numero_salida', v_num_sal,
    'numero_ingreso', v_num_ing
  );
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. piso_registrar_movimiento — INGRESO/DEVOLUCIÓN ATÓMICOS.
--    Firma ampliada (+ _posicion_id uuid al final) y cuerpo actualizado:
--    lote, fecha tolerante, secuencia, locks. La firma de 8 argumentos se
--    retira (DROP) para evitar ambigüedad de resolución en PostgREST;
--    ningún caller activo la usaba (ruta muerta del frontend).
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.piso_registrar_movimiento(text, text, jsonb, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.piso_registrar_movimiento(
  _tipo            text,
  _turno           text,
  _detalles        jsonb DEFAULT '[]'::jsonb,
  _uuid_sync       text DEFAULT NULL::text,
  _codigo_inc      text DEFAULT NULL::text,
  _usuario_id      text DEFAULT NULL::text,
  _usuario_nombre  text DEFAULT NULL::text,
  _usuario_correo  text DEFAULT NULL::text,
  _posicion_id     uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_mov_id   uuid;
  v_num_out  bigint;
  v_detalle  jsonb;
  v_nivel_id uuid;
  v_txt      text;
  v_fecha    date;
BEGIN
  IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar movimientos';
  END IF;

  IF _tipo NOT IN ('ingreso', 'devolucion', 'stock_inicial') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO|piso_registrar_movimiento solo acepta ingreso/devolucion/stock_inicial (las salidas van por piso_salida_posicion)';
  END IF;

  -- Idempotencia
  IF _uuid_sync IS NOT NULL AND _uuid_sync <> '' THEN
    SELECT id INTO v_mov_id FROM piso_movimientos WHERE uuid_sync = _uuid_sync LIMIT 1;
    IF v_mov_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'id', v_mov_id, 'idempotent', true);
    END IF;
  END IF;

  -- Locks por nivel (orden determinista)
  IF _detalles IS NOT NULL AND jsonb_array_length(_detalles) > 0 THEN
    FOR v_nivel_id IN
      SELECT DISTINCT (d->>'nivel_id')::uuid
      FROM jsonb_array_elements(_detalles) AS d
      ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_nivel_id::text, 0));
    END LOOP;
  END IF;

  -- Cabecera (numero_operacion por SECUENCIA; codigo_inc y posicion_id opcionales)
  INSERT INTO piso_movimientos (tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, codigo_inc, posicion_id)
  VALUES (_tipo, now(), _turno, NULLIF(btrim(_usuario_id), '')::uuid, _usuario_nombre, _usuario_correo, _uuid_sync, NULLIF(_codigo_inc, ''), _posicion_id)
  RETURNING id, numero_operacion INTO v_mov_id, v_num_out;

  -- Detalles (lote + fecha tolerante)
  IF _detalles IS NOT NULL AND jsonb_array_length(_detalles) > 0 THEN
    FOR v_detalle IN SELECT * FROM jsonb_array_elements(_detalles)
    LOOP
      v_txt   := v_detalle->>'fecha_vencimiento';
      v_fecha := NULL;
      IF v_txt IS NOT NULL AND v_txt <> '' AND v_txt <> 'null' THEN
        BEGIN
          v_fecha := to_date(v_txt, 'YYYY-MM-DD');
        EXCEPTION WHEN OTHERS THEN
          BEGIN
            v_fecha := v_txt::timestamptz::date;
          EXCEPTION WHEN OTHERS THEN
            v_fecha := NULL;
          END;
        END;
      END IF;

      INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
      VALUES (
        v_mov_id,
        (v_detalle->>'nivel_id')::uuid,
        (v_detalle->>'bloque_id')::uuid,
        COALESCE((v_detalle->>'cantidad')::numeric, 0),
        v_fecha,
        NULLIF(btrim(COALESCE(v_detalle->>'lote', '')), '')
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_mov_id, 'numero_operacion', v_num_out);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. piso_stock_detalle_posicion — FEFO DIRIGIDO (alineada con la app).
--    Una salida descuenta PRIMERO el lote con SU fecha registrada (o el lote
--    S/F si la salida no trajo fecha); solo el remanente desborda en orden
--    FEFO (fechas ascendentes, S/F al final). Nunca deja lotes negativos y
--    el total por bloque siempre es igual a ingresos − salidas.
--    (Cuerpo adaptado de download/rackly_fefo_dirigido.sql a la firma uuid
--    vigente; la app NO la llama todavía — calcula client-side — pero queda
--    alineada para reactivar la ruta server-side cuando se decida.)
--    El retorno de bloque_id cambia uuid→text (soporta bloques virtuales
--    cat_<codigo>): DROP + CREATE. Nada depende de ella (sin callers ni views).
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.piso_stock_detalle_posicion(uuid);

CREATE OR REPLACE FUNCTION public.piso_stock_detalle_posicion(_posicion_id uuid)
RETURNS TABLE (
  bloque_id           text,
  bloque_codigo       text,
  bloque_descripcion  text,
  bloque_unidad       text,
  cantidad            numeric,
  fecha_vencimiento   text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ingresos  jsonb := '{}'::jsonb;
  v_salidas   jsonb := '[]'::jsonb;
  det         RECORD;
  s           jsonb;
  b_id        text;
  v_key       text;
  v_val       numeric;
  i           int;
  pend        numeric;
  disp        numeric;
  tomar       numeric;
  v_codigo    text;
  v_desc      text;
  v_un        text;
BEGIN
  -- 1) Detalles de la posición en ORDEN TEMPORAL
  FOR det IN
    SELECT d.bloque_id                       AS b,
           COALESCE(d.fecha_vencimiento, '') AS fv,
           d.cantidad                        AS q,
           COALESCE(m.tipo, '')              AS tipo
    FROM piso_movimiento_detalles d
    JOIN piso_movimientos m ON m.id = d.movimiento_id
    WHERE d.nivel_id IN (SELECT n.id FROM piso_niveles n WHERE n.posicion_id = _posicion_id)
    ORDER BY m.fecha ASC NULLS LAST, m.id ASC
  LOOP
    IF det.q IS NULL OR det.q <= 0 THEN
      CONTINUE;
    END IF;

    IF det.tipo IN ('ingreso', 'stock_inicial', 'devolucion') THEN
      v_ingresos := jsonb_set(
        v_ingresos,
        ARRAY[det.b::text, det.fv],
        to_jsonb(COALESCE((v_ingresos #>> ARRAY[det.b::text, det.fv])::numeric, 0) + det.q),
        true
      );
    ELSE
      v_salidas := v_salidas || jsonb_build_object('b', det.b::text, 'v', det.fv, 'q', det.q);
    END IF;
  END LOOP;

  -- 2) Salidas: dirigida al lote elegido + desborde FEFO
  FOR i IN 0 .. COALESCE(jsonb_array_length(v_salidas), 0) - 1
  LOOP
    s    := v_salidas -> i;
    b_id := s ->> 'b';
    pend := (s ->> 'q')::numeric;

    IF b_id IS NULL OR NOT (v_ingresos ? b_id) OR pend <= 0 THEN
      CONTINUE;
    END IF;

    IF COALESCE(s ->> 'v', '') <> '' THEN
      disp := COALESCE((v_ingresos #>> ARRAY[b_id, s ->> 'v'])::numeric, 0);
      IF disp > 0 THEN
        tomar := LEAST(pend, disp);
        v_ingresos := jsonb_set(v_ingresos, ARRAY[b_id, s ->> 'v'], to_jsonb(disp - tomar));
        pend := pend - tomar;
      END IF;
    ELSE
      disp := COALESCE((v_ingresos #>> ARRAY[b_id, ''])::numeric, 0);
      IF disp > 0 THEN
        tomar := LEAST(pend, disp);
        v_ingresos := jsonb_set(v_ingresos, ARRAY[b_id, ''], to_jsonb(disp - tomar));
        pend := pend - tomar;
      END IF;
    END IF;

    IF pend > 0 THEN
      FOR v_key IN
        SELECT k FROM jsonb_object_keys(v_ingresos -> b_id) AS ks(k)
        ORDER BY CASE WHEN k = '' THEN 1 ELSE 0 END ASC, k ASC
      LOOP
        EXIT WHEN pend <= 0;
        disp := COALESCE((v_ingresos #>> ARRAY[b_id, v_key])::numeric, 0);
        IF disp > 0 THEN
          tomar := LEAST(pend, disp);
          v_ingresos := jsonb_set(v_ingresos, ARRAY[b_id, v_key], to_jsonb(disp - tomar));
          pend := pend - tomar;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- 3) Lotes remanentes (solo > 0)
  FOR b_id IN SELECT k FROM jsonb_object_keys(v_ingresos) AS ks(k)
  LOOP
    FOR v_key, v_val IN
      SELECT k, (v_ingresos -> b_id ->> k)::numeric
      FROM jsonb_object_keys(v_ingresos -> b_id) AS ks(k)
      ORDER BY CASE WHEN k = '' THEN 1 ELSE 0 END ASC, k ASC
    LOOP
      IF v_val IS NULL OR v_val <= 0 THEN
        CONTINUE;
      END IF;

      SELECT pb.codigo, COALESCE(pb.descripcion, ''), COALESCE(pb.unidad, 'KG')
        INTO v_codigo, v_desc, v_un
        FROM piso_bloques pb
       WHERE pb.id::text = b_id
       LIMIT 1;

      IF NOT FOUND THEN
        SELECT c.codigo, COALESCE(c.descripcion, ''), COALESCE(c.un, 'KG')
          INTO v_codigo, v_desc, v_un
          FROM catalogo c
         WHERE 'cat_' || c.codigo = b_id
         LIMIT 1;
      END IF;

      IF FOUND THEN
        bloque_id          := b_id;
        bloque_codigo      := v_codigo;
        bloque_descripcion := v_desc;
        bloque_unidad      := v_un;
        cantidad           := round(v_val, 3);
        fecha_vencimiento  := v_key;
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. HARDENING de permisos — mismo criterio que la auditoría aplicó a
--    transito_registrar_envio: las funciones de ESCRITURA (y los lectores
--    SECURITY DEFINER) no se ejecutan jamás por el rol anónimo.
--    postgres / authenticated / service_role conservan EXECUTE explícito.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.piso_salida_posicion(text, text, text, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.piso_salida_posicion(text, text, text, text, text, jsonb)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.piso_traslado_posicion(text, text, text, text, text, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.piso_traslado_posicion(text, text, text, text, text, jsonb, jsonb)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.piso_registrar_movimiento(text, text, jsonb, text, text, text, text, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.piso_registrar_movimiento(text, text, jsonb, text, text, text, text, text, uuid)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.piso_registrar_salida(text, uuid, text, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.piso_registrar_salida(text, uuid, text, text, text, jsonb)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.piso_registrar_traslado(text, uuid, text, text, text, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.piso_registrar_traslado(text, uuid, text, text, text, jsonb, jsonb)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.piso_eliminar_movimiento(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.piso_eliminar_movimiento(uuid)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.piso_reemplazar_catalogo_bloques(jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.piso_reemplazar_catalogo_bloques(jsonb)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.rackly_reemplazar_movimientos(jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rackly_reemplazar_movimientos(jsonb)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.registrar_movimiento_kardex(text, text, text, text, text, text, text, text, numeric, date, text, uuid, text, text, text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_movimiento_kardex(text, text, text, text, text, text, text, text, numeric, date, text, uuid, text, text, text, text, text, text)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.registrar_traslado_kardex(text, text, text, numeric, text, text, text, text, text, text, text, text, text, uuid, text, text, date, text, numeric, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_traslado_kardex(text, text, text, numeric, text, text, text, text, text, text, text, text, text, uuid, text, text, date, text, numeric, text, text, text)
  TO authenticated, service_role;

-- Lectores SECURITY DEFINER: la lectura del módulo ya está cubierta por
-- authenticated; anon no necesita ejecutarlas directamente.
REVOKE EXECUTE ON FUNCTION public.piso_stock_detalle_posicion(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.piso_stock_detalle_posicion(uuid)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.ocupacion_celdas()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ocupacion_celdas()
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Integridad: numero_operacion sin duplicados (todas las rutas de
--    escritura usan ya la misma secuencia; hoy no existen duplicados).
-- ─────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS piso_movimientos_numero_operacion_uidx
  ON public.piso_movimientos (numero_operacion)
  WHERE numero_operacion IS NOT NULL;

COMMIT;
