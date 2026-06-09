-- Migration: Add codigo_inc column to piso_movimientos table for INC feature
-- INC = Insumo No Conforme (Non-conforming input material)
-- NULL = producto disponible, has value = INC (not available for production lines)

ALTER TABLE public.piso_movimientos ADD COLUMN IF NOT EXISTS codigo_inc TEXT;
