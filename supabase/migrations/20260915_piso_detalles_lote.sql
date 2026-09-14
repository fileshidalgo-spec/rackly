-- ═══════════════════════════════════════════════════════════════════════════
--  RACKLY · Piso (pestaña Sectores) · Campo LOTE en ingresos/devoluciones
--  2026-09-15 · v1
--
--  PROPÓSITO
--    Replicar en el módulo Piso el campo "Lote" que ya funciona en Racks:
--    el usuario puede digitar el código de lote FÍSICO del producto al
--    registrar INGRESOS y DEVOLUCIONES (pestaña Sectores). Es informativo
--    (trazabilidad): NO afecta stock, FEFO ni salidas, igual que en Racks.
--
--  ESTADO EN PRODUCCIÓN
--    ✅ YA APLICADO (2026-09-15) vía Supabase Management API y verificado
--       (information_schema + conteo 1057 detalles intactos, con_lote=0).
--       NO hace falta ejecutarlo de nuevo en este proyecto.
--    Usa este archivo solo para RECREAR el esquema en un proyecto nuevo.
--
--  NOTAS TÉCNICAS
--    - piso_movimiento_detalles usa cabecera (piso_movimientos) + detalles.
--      El lote va POR DETALLE (como fecha_vencimiento), porque un ingreso
--      multilínea puede traer lotes distintos por artículo.
--    - Idempotente: ADD COLUMN IF NOT EXISTS.
--    - No toca RLS, grants de otros objetos, ni datos existentes.
--    - Los detalles históricos quedan con lote NULL = "sin lote".
--    - El frontend reintenta el insert SIN lote si la columna no existiera
--      todavía (mismo patrón defensivo que kardex.ts en Racks).
-- ═══════════════════════════════════════════════════════════════════════════

-- BLOQUE ÚNICO · Columna lote por detalle de movimiento de Piso
ALTER TABLE public.piso_movimiento_detalles
  ADD COLUMN IF NOT EXISTS lote TEXT;

COMMENT ON COLUMN public.piso_movimiento_detalles.lote IS
  'Codigo de lote FISICO digitado en ingresos/devoluciones (ej: AP-304501210021). Informativo: no afecta stock ni FEFO. NULL = sin lote.';

-- Verificación rápida (esperado: una fila con lote | text | YES)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'piso_movimiento_detalles'
  AND column_name = 'lote';
