-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · Task 25 (Atención) — RPC atómica de creación de RQ
--
-- Problema (auditoría 2026-10-27):
--   crearRq insertaba header e items en DOS peticiones cliente:
--     · El id de idempotencia se generaba POR LLAMADA → un reintento tras
--       "respuesta perdida" creaba la RQ DOS VECES (ids distintos nunca
--       chocan con la PK).
--     · Si el header entraba y los items fallaban (red móvil), el reintento
--       detectaba duplicate y devolvía ÉXITO sin materiales.
--
-- Solución: UNA transacción en la BD, idempotente:
--   · Header con ON CONFLICT (id) DO NOTHING (reintento seguro).
--   · Items: se insertan SOLO los que faltan (guard orden+codigo+rq) —
--     el reintento completa la RQ a medias en vez de duplicar nada.
--
-- Seguridad: SECURITY DEFINER con search_path fijo (mismo patrón que
-- rq_atender_lote). EXECUTE solo para authenticated (parity con la política
-- RLS rq_insert_auth: INSERT true para authenticated).
-- Ejecutar como admin (MAPI). Re-ejecutable (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rq_crear_completa(
  p_rq    jsonb,
  p_items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id    uuid;
  v_item  jsonb;
BEGIN
  v_id := (p_rq->>'id')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'ID_REQUERIDO|la RQ debe traer id preasignado (idempotencia)';
  END IF;

  INSERT INTO rq_atenciones (
    id, fecha, numero_rq, orden_produccion, producto_codigo,
    producto_descripcion, turno, linea, solicitante, estado,
    foto_url, notas, usuario_id, usuario_nombre, usuario_correo
  ) VALUES (
    v_id,
    coalesce((p_rq->>'fecha')::date, CURRENT_DATE),
    coalesce(p_rq->>'numero_rq', ''),
    coalesce(p_rq->>'orden_produccion', ''),
    coalesce(p_rq->>'producto_codigo', ''),
    coalesce(p_rq->>'producto_descripcion', ''),
    coalesce(p_rq->>'turno', 'T1'),
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
$fn$;

-- EXECUTE solo para usuarios de la app (parity con rq_insert_auth RLS).
REVOKE ALL ON FUNCTION public.rq_crear_completa(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rq_crear_completa(jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.rq_crear_completa(jsonb, jsonb) TO authenticated;
