-- ═══════════════════════════════════════════════════════════════════════════
-- La sobrecarga VIEJA de 4 args quedó con la lógica duplicada (el CREATE OR
-- REPLACE de 8 args creó una entrada nueva en pg_proc; la de 4 siguió
-- apuntando al cuerpo antiguo). Mismo patrón de la auditoría 2026-11-10
-- (rq_atender_item): la sobrecarga corta DELEGA en la larga — fuente única
-- de verdad, ledger de documento garantizado sea cual sea la resolución de
-- PostgREST.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rep_registrar_ingreso(
  p_articulo_id uuid,
  p_lonchera_id uuid,
  p_cantidad numeric,
  p_referencia text DEFAULT ''::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.rep_registrar_ingreso(
    p_articulo_id, p_lonchera_id, p_cantidad, p_referencia,
    '', '', '', ''
  );
END
$function$;
