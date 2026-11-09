-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — Auditoría integral 2026-11-10 (post-Repuestos)
-- 1) RLS en piso_stock_nivel (estaba sin RLS y con privilegios plenos a anon)
-- 2) Índices de soporte para FKs de rep_movimientos (origen/destino)
-- 3) rq_atender_item 3-args delega en la variante 4-args (fuente única de
--    verdad: garantiza ledger de tomas 'manual' sin importar qué sobrecarga
--    resuelva PostgREST) + search_path fijado.
-- Todos los pasos son aditivos o compatibles: sin cambios de comportamiento
-- para usuarios legítimos.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) RLS piso_stock_nivel ────────────────────────────────────────────────
-- El snapshot lo mantienen triggers que corren como el llamador
-- (authenticated), y el frontend no lo lee directamente (solo vía RPC
-- SECURITY DEFINER, que ignora RLS). Policy permissive para authenticated
-- replica el patrón de las demás tablas piso_*; anon queda sin acceso.
ALTER TABLE public.piso_stock_nivel ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS piso_stock_nivel_auth ON public.piso_stock_nivel;
CREATE POLICY piso_stock_nivel_auth
  ON public.piso_stock_nivel
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── 2) Índices de FKs sin soporte en rep_movimientos ───────────────────────
CREATE INDEX IF NOT EXISTS idx_rep_movs_origen_ubi
  ON public.rep_movimientos (origen_ubicacion_id);
CREATE INDEX IF NOT EXISTS idx_rep_movs_destino_ubi
  ON public.rep_movimientos (destino_ubicacion_id);

-- ── 3) Sobrecarga 3-args de rq_atender_item → delega en 4-args ─────────────
-- Elimina la lógica duplicada (la copia antigua no insertaba el ledger de
-- tomas 'manual') y fija search_path por consistencia con el resto de RPCs.
CREATE OR REPLACE FUNCTION public.rq_atender_item(
  p_item_id uuid,
  p_cantidad numeric,
  p_usuario text
)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.rq_atender_item(p_item_id, p_cantidad, p_usuario, NULL);
END
$function$;
