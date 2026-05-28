-- ═══ MIGRATION: Agregar fecha_vencimiento a piso_movimiento_detalles ═══
-- Permite registrar fecha de vencimiento por detalle de movimiento

ALTER TABLE piso_movimiento_detalles
  ADD COLUMN IF NOT EXISTS fecha_vencimiento date;

-- Comentario
COMMENT ON COLUMN piso_movimiento_detalles.fecha_vencimiento IS 'Fecha de vencimiento del producto ingresado. NULL = sin vencimiento.';
