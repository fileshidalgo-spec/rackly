-- RACKLY — Recepción: separar "Empresa de Origen" (empresa que envía) del
-- "Proveedor" del artículo (proveedor real del producto, p. ej. film
-- lámina/stretch: INCOMIN, DAMAR, NEOPACK…).
--
-- Problema (reporte 2026-10-22): una guía llega desde AJEPER S. A. pero
-- dentro trae multi-productos con DISTINTOS proveedores. La columna
-- `proveedor` de recepcion_registros guardaba la empresa que envía y la RPC
-- transito_registrar_envio la copia tal cual a movimientos.proveedor (kardex)
-- — el film llegaba a Racks con el proveedor equivocado.
--
-- Solución:
--   · Columna NUEVA empresa_origen = empresa que envía (nivel guía, se
--     repite en todas las filas del documento, igual que hoy).
--   · La columna existente `proveedor` pasa a ser el PROVEEDOR DEL ARTÍCULO
--     (por fila; '' cuando el producto no lo requiere). Sin cambiar la RPC:
--     sigue leyendo `proveedor`, que ahora porta el valor correcto.
--   · BACKFILL: las filas legacy reciben empresa_origen = proveedor (hoy
--     ese valor ES la empresa que envía) — cero pérdida de datos, los
--     listados históricos se muestran idénticos.

ALTER TABLE public.recepcion_registros
  ADD COLUMN IF NOT EXISTS empresa_origen text;

-- Backfill idempotente: solo filas aún sin empresa_origen.
UPDATE public.recepcion_registros
SET empresa_origen = proveedor
WHERE empresa_origen IS NULL;

COMMENT ON COLUMN public.recepcion_registros.empresa_origen IS
  'Empresa que envía la guía (nivel documento, ej. AJEPER S. A.). El proveedor real del artículo vive en la columna proveedor.';
