-- Migration: Add codigo_inc column to movimientos table
-- INC = Insumo No Conforme (Non-conforming input material)
-- NULL = producto disponible, has value = INC (not available for production lines)

ALTER TABLE public.movimientos ADD COLUMN IF NOT EXISTS codigo_inc TEXT;

-- Index for fast filtering by codigo_inc
CREATE INDEX IF NOT EXISTS idx_movimientos_codigo_inc ON public.movimientos (codigo_inc) WHERE codigo_inc IS NOT NULL;
