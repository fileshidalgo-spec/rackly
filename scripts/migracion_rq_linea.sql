-- ═════════════════════════════════════════════════════════════════════
-- RACKLY · Task 13 — Módulo Atención: campo LÍNEA de producción en la RQ
-- ═════════════════════════════════════════════════════════════════════
-- El documento físico (Requisición de Despacho de Materiales AJEPER) trae
-- el campo "Línea:" (ej.: "0 TANQUES DE JARABE GASEOSA", "L1", "JARABES")
-- y la app nunca lo capturó. Esta migración añade la columna al encabezado
-- de la RQ. NOT NULL DEFAULT '' → los INSERT existentes siguen válidos y
-- ninguna RPC toca esta tabla (verificado: 0 funciones mencionan rq_atenciones).

ALTER TABLE public.rq_atenciones
  ADD COLUMN IF NOT EXISTS linea text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.rq_atenciones.linea IS
  'Línea/área de producción que pide la RQ (campo "Línea:" del documento físico). Ej.: L1, L2, L3, JARABES.';

-- Backfill trazable: la única RQ existente (0000191373) corresponde al
-- documento real proporcionado por el usuario, cuyo campo dice
-- "Línea : 0 TANQUES DE JARABE GASEOSA".
UPDATE public.rq_atenciones
SET linea = '0 TANQUES DE JARABE GASEOSA'
WHERE numero_rq = '0000191373' AND linea = '';

-- Verificación
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='rq_atenciones' AND column_name='linea';

SELECT numero_rq, linea FROM public.rq_atenciones ORDER BY created_at DESC LIMIT 3;
