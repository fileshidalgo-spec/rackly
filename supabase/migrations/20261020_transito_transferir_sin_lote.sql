-- ═══════════════════════════════════════════════════════════════════
-- RACKLY — TRÁNSITO: permitir transferir SIN lote / fechas (v2, 2026-10-20)
-- Módulo: TRANSITO · pedido del usuario 2026-10-20
--
-- PROBLEMA (1.2): la RPC bloqueaba con SIN_LOTE_VENCIMIENTO todo artículo
--   sin lote o sin fecha de vencimiento. En la operación real el proveedor
--   a veces NO trae esos datos y la mercadería quedaba "congelada" en
--   Tránsito sin poder moverse a Rack/Piso.
--
-- CONTEXTO QUE HACE SEGURA LA APERTURA:
--   · editar_lote v1/v2 (20261020_editar_lote_vencimiento*.sql) permite
--     COMPLETAR/CORREGIR lote y fechas DESPUÉS del ingreso en Racks y Piso
--     (retro-etiquetado consistente del bucket "sin lote / sin fecha").
--   · registrar_movimiento_kardex acepta p_f_vencimiento NULL y hace
--     NULLIF(TRIM(p_lote),'') — "sin lote" ya es estado soportado.
--   · piso_movimiento_detalles.lote es nullable ("NULL = sin lote").
--   · La UI (DialogoTransferir) pide CONFIRMACIÓN EXPLÍCITA cuando el
--     artículo va sin esos datos: transferencia consciente, no silenciosa.
--
-- CAMBIOS (base = definición REAL de producción, que incluye el guard de
-- auth del hardening 2026-10-16 — NO regenerar desde 20261014_transito.sql):
--   1) ELIMINADO el bloque SIN_LOTE_VENCIMIENTO (lote/venc faltantes ya no
--      bloquean; el anti-sobreenvío y la idempotencia siguen intactos).
--   2) lote vacío se normaliza a NULL al escribir en los destinos
--      (NULLIF(v_lote,'')): un solo convenio "sin lote = NULL" en Kardex
--      y Piso — así el bucket lo encuentra editar_lote y el FEFO agrupa igual.
--   3) Todo lo demás byte-idéntico: guard NO_AUTORIZADO, advisory lock,
--      idempotencia por uuid, anti-sobreenvío, jsonb de envíos, retorno.
--
-- VERIFICADO EN PRODUCCIÓN: firma/grants intactos (CREATE OR REPLACE
-- conserva permisos del hardening: solo authenticated + service_role).
-- ═══════════════════════════════════════════════════════════════════

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
  -- GUARD de autorización: la RPC es SECURITY DEFINER (escribe en movimientos,
  -- piso_movimientos, recepcion_registros). Nunca ejecutable por anon.
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar envíos de Tránsito';
  END IF;

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

  -- Regla TRÁNSITO (v2 2026-10-20): SIN lote o SIN fecha de vencimiento ya NO
  -- bloquea. El proveedor a veces no trae esos datos; se transfieren CON
  -- confirmación explícita en la UI y luego se completan/corrigen con
  -- editar_lote (v1/v2) en Racks/Piso. lote='' se normaliza a NULL abajo.

  v_lote := TRIM(COALESCE(v_row.lote, ''));
  v_venc := v_row.fecha_vencimiento;

  v_codigo := UPPER(TRIM(v_row.codigo));
  v_descripcion := v_row.descripcion;
  v_un := v_row.unidad_medida;
  v_prov := v_row.proveedor;

  IF p_tipo_destino = 'rack' THEN
    IF p_rack IS NULL OR COALESCE(p_rack ->> 'bloque', '') = '' THEN
      RAISE EXCEPTION 'UBICACION_RACK_REQUERIDA|Falta la ubicación del rack (bloque/torre/piso/posición)';
    END IF;
    -- Ingreso NATIVO en Racks (misma RPC que usa el módulo) — misma transacción:
    -- si esto falla, NO se marca nada en Tránsito. Acepta v_venc NULL y
    -- lote NULL ('' → NULLIF: "sin lote" en un solo convenio).
    v_res := public.registrar_movimiento_kardex(
      'ingreso',
      p_rack ->> 'bloque', p_rack ->> 'torre', p_rack ->> 'piso', p_rack ->> 'posicion',
      v_codigo, v_descripcion, v_un, p_cantidad, v_venc, p_turno,
      p_usuario_id, p_usuario_nombre, p_usuario_correo, v_prov,
      p_uuid_sync, NULL, NULLIF(v_lote, '')
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

    -- Ingreso NATIVO en Piso (cabecera + detalle, igual que registrarIngresoPosicion).
    -- fecha_vencimiento y lote son nullable: NULL = sin dato (se completa luego).
    INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, posicion_id)
    VALUES (
      'ingreso', p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo,
      p_uuid_sync, NULLIF(p_piso ->> 'posicion_id', '')::uuid
    ) RETURNING id INTO v_mov_id;

    INSERT INTO public.piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    VALUES (v_mov_id, (p_piso ->> 'nivel_id')::uuid, v_bloque_piso_id, p_cantidad, v_venc, NULLIF(v_lote, ''));
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

-- Permisos: CREATE OR REPLACE los conserva; se re-declara el GRANT del
-- hardening 2026-10-16 como constancia (idempotente).
REVOKE EXECUTE ON FUNCTION
  public.transito_registrar_envio(uuid, text, numeric, text, uuid, text, text, text, jsonb, jsonb, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.transito_registrar_envio(uuid, text, numeric, text, uuid, text, text, text, jsonb, jsonb, text)
TO authenticated, service_role;
