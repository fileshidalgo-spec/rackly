-- ═══════════════════════════════════════════════════════════════════════
-- RACKLY — Auditoría integral 2026-11-01 (trace 1a1976a1b9d39725)
-- Cierre de superficie expuesta: RPCs de mantenimiento FEFO sin guard.
--
-- HALLAZGO: rackly_backfill_lote_fefo y rackly_rebalance_lotes_fefo son
--   SECURITY DEFINER y MUTAN movimientos/piso_bloques (backfill y
--   rebalanceo de lotes), NO tienen guard de permiso interno y tenían
--   EXECUTE concedido a anon y authenticated. La app NO las llama
--   (cero referencias en src/ — fueron RPCs puntuales de reparación
--   FEFO ejecutadas por service_role/postgres en su día).
-- RIESGO: cualquiera con la anon key podía disparar una rebalanceación
--   de lotes sobre datos de producción.
-- PROCEDIMIENTO: REVOKE EXECUTE a anon y authenticated. Se conservan
--   postgres y service_role (los únicos ejecutores legítimos).
-- IMPACTO EN LA APP: cero (sin llamadores). Verificado con E2E tras
--   aplicar: anon recibe "permission denied", service_role sigue OK.
-- ═══════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.rackly_backfill_lote_fefo() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rackly_rebalance_lotes_fefo() FROM anon, authenticated;
