-- ═══════════════════════════════════════════════════════════════════
-- RACKLY — Módulo TRÁNSITO (puente Recepción → Racks/Pisos)
-- Aplicado en producción el 2026-10-14 vía Management API.
--  1) Columna transito (jsonb) en recepcion_registros: historial de envíos
--     por artículo [{uuid, fecha, destino, ubicacion, cantidad, usuario…}]
--  2) RPC transito_registrar_envio: atómica (advisory lock por fila),
--     idempotente por uuid del envío, anti-sobreenvío (bloquea con el
--     excedente), bloquea artículos sin lote/vencimiento, y registra el
--     ingreso NATIVO en el módulo destino en la misma transacción:
--       · rack → llama a registrar_movimiento_kardex(...)
--       · piso → inserta piso_movimientos + piso_movimiento_detalles
--         (resuelve/crea el bloque del catálogo piso por código)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.recepcion_registros
  ADD COLUMN IF NOT EXISTS transito jsonb DEFAULT NULL;

COMMENT ON COLUMN public.recepcion_registros.transito IS
  'TRÁNSITO: {"v":1,"envios":[{uuid,fecha,destino,ubicacion,cantidad,usuario_id,usuario_nombre,turno,rack,piso}]} — envíos del módulo Tránsito. NULL = sin envíos.';

CREATE OR REPLACE FUNCTION public.transito_registrar_envio(
  p_recepcion_id uuid,
  p_tipo_destino text,
  p_cantidad numeric,
  p_turno text,
  p_usuario_id uuid,
  p_usuario_nombre text,
  p_usuario_correo text,
  p_uuid_sync text,
  p_rack jsonb DEFAULT NULL,
  p_piso jsonb DEFAULT NULL,
  p_ubicacion text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_row public.recepcion_registros%ROWTYPE;
  v_envios jsonb;
  v_enviados numeric;
  v_pendiente numeric;
  v_nuevo jsonb;
  v_lote text;
  v_venc date;
  v_codigo text;
  v_descripcion text;
  v_un text;
  v_prov text;
  v_res jsonb;
  v_mov_id uuid;
  v_bloque_piso_id uuid;
BEGIN
  IF p_tipo_destino NOT IN ('rack', 'piso') THEN
    RAISE EXCEPTION 'DESTINO_INVALIDO|El destino debe ser rack o piso (recibido: %)', p_tipo_destino;
  END IF;
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad a transferir debe ser mayor que cero';
  END IF;
  IF p_uuid_sync IS NULL OR TRIM(p_uuid_sync) = '' THEN
    RAISE EXCEPTION 'UUID_REQUERIDO|Falta el identificador único del envío';
  END IF;

  -- Lock por fila de recepción: dos envíos simultáneos del mismo artículo se
  -- serializan y el anti-sobreenvío siempre ve el total real.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_recepcion_id::text, 7771));

  SELECT * INTO v_row FROM public.recepcion_registros WHERE id = p_recepcion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEPCION_NO_EXISTE|La fila de recepción ya no existe';
  END IF;

  v_envios := COALESCE(v_row.transito -> 'envios', '[]'::jsonb);

  -- IDEMPOTENCIA: mismo uuid del envío => ya registrado, devolver éxito sin tocar nada
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_envios) AS e
    WHERE e ->> 'uuid' = p_uuid_sync
  ) THEN
    RETURN jsonb_build_object('ok', true, 'duplicado', true, 'recepcion_id', p_recepcion_id);
  END IF;

  -- ANTI-SOBREENVÍO: lo enviado no puede superar la cantidad registrada
  SELECT COALESCE(SUM((e ->> 'cantidad')::numeric), 0) INTO v_enviados
  FROM jsonb_array_elements(v_envios) AS e;
  v_pendiente := v_row.cantidad - v_enviados;
  IF p_cantidad > v_pendiente THEN
    RAISE EXCEPTION 'OVER_ISSUE|La cantidad a transferir (%) excede el pendiente de % (%): excedente %',
      p_cantidad, v_row.codigo, v_pendiente, (p_cantidad - v_pendiente);
  END IF;

  -- Regla TRÁNSITO: sin lote o sin fecha de vencimiento NO se puede transferir
  v_lote := TRIM(COALESCE(v_row.lote, ''));
  v_venc := v_row.fecha_vencimiento;
  IF v_lote = '' OR v_venc IS NULL THEN
    RAISE EXCEPTION 'SIN_LOTE_VENCIMIENTO|El artículo % no tiene lote o fecha de vencimiento — no es transferible desde Tránsito', v_row.codigo;
  END IF;

  v_codigo := UPPER(TRIM(v_row.codigo));
  v_descripcion := v_row.descripcion;
  v_un := v_row.unidad_medida;
  v_prov := v_row.proveedor;

  IF p_tipo_destino = 'rack' THEN
    IF p_rack IS NULL OR COALESCE(p_rack ->> 'bloque', '') = '' THEN
      RAISE EXCEPTION 'UBICACION_RACK_REQUERIDA|Falta la ubicación del rack (bloque/torre/piso/posición)';
    END IF;
    -- Ingreso NATIVO en Racks (misma RPC que usa el módulo) — misma transacción:
    -- si esto falla, NO se marca nada en Tránsito.
    v_res := public.registrar_movimiento_kardex(
      'ingreso',
      p_rack ->> 'bloque', p_rack ->> 'torre', p_rack ->> 'piso', p_rack ->> 'posicion',
      v_codigo, v_descripcion, v_un, p_cantidad, v_venc, p_turno,
      p_usuario_id, p_usuario_nombre, p_usuario_correo, v_prov,
      p_uuid_sync, NULL, v_lote
    );
  ELSE
    IF p_piso IS NULL OR COALESCE(p_piso ->> 'nivel_id', '') = '' THEN
      RAISE EXCEPTION 'UBICACION_PISO_REQUERIDA|Falta el nivel de destino del piso';
    END IF;

    -- Bloque del catálogo Piso: resolver por código; crearlo si no existe
    -- (puente Recepción → Piso sin doble digitación).
    SELECT id INTO v_bloque_piso_id FROM public.piso_bloques WHERE codigo = v_codigo;
    IF NOT FOUND THEN
      INSERT INTO public.piso_bloques (codigo, descripcion, unidad)
      VALUES (v_codigo, v_descripcion, v_un)
      ON CONFLICT (codigo) DO NOTHING;
      SELECT id INTO v_bloque_piso_id FROM public.piso_bloques WHERE codigo = v_codigo;
    END IF;

    -- Ingreso NATIVO en Piso (cabecera + detalle, igual que registrarIngresoPosicion)
    INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, posicion_id)
    VALUES (
      'ingreso', p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo,
      p_uuid_sync, NULLIF(p_piso ->> 'posicion_id', '')::uuid
    ) RETURNING id INTO v_mov_id;

    INSERT INTO public.piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    VALUES (v_mov_id, (p_piso ->> 'nivel_id')::uuid, v_bloque_piso_id, p_cantidad, v_venc, v_lote);
  END IF;

  -- Marca TRÁNSITO sobre la fila de recepción (historial completo por artículo)
  v_nuevo := jsonb_build_object(
    'uuid', p_uuid_sync,
    'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
    'destino', p_tipo_destino,
    'ubicacion', COALESCE(p_ubicacion, ''),
    'cantidad', p_cantidad,
    'usuario_id', p_usuario_id,
    'usuario_nombre', p_usuario_nombre,
    'turno', p_turno,
    'rack', p_rack,
    'piso', p_piso
  );
  UPDATE public.recepcion_registros
  SET transito = jsonb_build_object('v', 1, 'envios', (v_envios || jsonb_build_array(v_nuevo)))
  WHERE id = p_recepcion_id;

  v_enviados := v_enviados + p_cantidad;
  v_pendiente := v_row.cantidad - v_enviados;
  RETURN jsonb_build_object(
    'ok', true,
    'duplicado', false,
    'recepcion_id', p_recepcion_id,
    'enviados', v_enviados,
    'pendiente', v_pendiente,
    'estado', CASE WHEN v_pendiente <= 0 THEN 'COMPLETO' ELSE 'PARCIAL' END
  );
END;
$fn$;
