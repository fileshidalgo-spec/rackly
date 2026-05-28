-- ═══════════════════════════════════════════════════════════════════
-- RACKLY — Sección PISO: Creación de tablas, RPC y RLS
-- Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════

-- 1. Sectores (nivel superior: Agrupa columnas)
CREATE TABLE IF NOT EXISTS public.piso_sectores (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre TEXT NOT NULL,
  prefijo TEXT NOT NULL,
  n_columnas INTEGER NOT NULL DEFAULT 2,
  n_subcolumnas INTEGER NOT NULL DEFAULT 2,
  n_posiciones INTEGER NOT NULL DEFAULT 10,
  n_niveles INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.piso_sectores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "piso_sectores_select" ON public.piso_sectores FOR SELECT USING (true);
CREATE POLICY "piso_sectores_insert" ON public.piso_sectores FOR INSERT WITH CHECK (true);
CREATE POLICY "piso_sectores_update" ON public.piso_sectores FOR UPDATE USING (true);
CREATE POLICY "piso_sectores_delete" ON public.piso_sectores FOR DELETE USING (true);

-- 2. Columnas (letra A, B, C... dentro de un sector)
CREATE TABLE IF NOT EXISTS public.piso_columnas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  letra TEXT NOT NULL,
  sector_id UUID NOT NULL REFERENCES public.piso_sectores(id) ON DELETE CASCADE,
  UNIQUE (letra, sector_id)
);
ALTER TABLE public.piso_columnas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "piso_columnas_select" ON public.piso_columnas FOR SELECT USING (true);
CREATE POLICY "piso_columnas_insert" ON public.piso_columnas FOR INSERT WITH CHECK (true);
CREATE POLICY "piso_columnas_update" ON public.piso_columnas FOR UPDATE USING (true);
CREATE POLICY "piso_columnas_delete" ON public.piso_columnas FOR DELETE USING (true);

-- 3. Subcolumnas (código identificador dentro de una columna)
CREATE TABLE IF NOT EXISTS public.piso_subcolumnas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo TEXT NOT NULL,
  columna_id UUID NOT NULL REFERENCES public.piso_columnas(id) ON DELETE CASCADE,
  UNIQUE (codigo, columna_id)
);
ALTER TABLE public.piso_subcolumnas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "piso_subcolumnas_select" ON public.piso_subcolumnas FOR SELECT USING (true);
CREATE POLICY "piso_subcolumnas_insert" ON public.piso_subcolumnas FOR INSERT WITH CHECK (true);
CREATE POLICY "piso_subcolumnas_update" ON public.piso_subcolumnas FOR UPDATE USING (true);
CREATE POLICY "piso_subcolumnas_delete" ON public.piso_subcolumnas FOR DELETE USING (true);

-- 4. Posiciones (número de posición dentro de una subcolumna)
CREATE TABLE IF NOT EXISTS public.piso_posiciones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  numero INTEGER NOT NULL,
  subcolumna_id UUID NOT NULL REFERENCES public.piso_subcolumnas(id) ON DELETE CASCADE,
  UNIQUE (numero, subcolumna_id)
);
ALTER TABLE public.piso_posiciones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "piso_posiciones_select" ON public.piso_posiciones FOR SELECT USING (true);
CREATE POLICY "piso_posiciones_insert" ON public.piso_posiciones FOR INSERT WITH CHECK (true);
CREATE POLICY "piso_posiciones_update" ON public.piso_posiciones FOR UPDATE USING (true);
CREATE POLICY "piso_posiciones_delete" ON public.piso_posiciones FOR DELETE USING (true);

-- 5. Niveles (nivel de apilamiento dentro de una posición)
CREATE TABLE IF NOT EXISTS public.piso_niveles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  numero INTEGER NOT NULL,
  posicion_id UUID NOT NULL REFERENCES public.piso_posiciones(id) ON DELETE CASCADE,
  codigo_ubicacion TEXT,
  UNIQUE (numero, posicion_id)
);
ALTER TABLE public.piso_niveles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "piso_niveles_select" ON public.piso_niveles FOR SELECT USING (true);
CREATE POLICY "piso_niveles_insert" ON public.piso_niveles FOR INSERT WITH CHECK (true);
CREATE POLICY "piso_niveles_update" ON public.piso_niveles FOR UPDATE USING (true);
CREATE POLICY "piso_niveles_delete" ON public.piso_niveles FOR DELETE USING (true);

-- 6. Bloques (catálogo de códigos — sincronizado con tabla 'catalogo' de Racks)
CREATE TABLE IF NOT EXISTS public.piso_bloques (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  descripcion TEXT DEFAULT '',
  unidad TEXT DEFAULT 'KG',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.piso_bloques ENABLE ROW LEVEL SECURITY;
CREATE POLICY "piso_bloques_select" ON public.piso_bloques FOR SELECT USING (true);
CREATE POLICY "piso_bloques_insert" ON public.piso_bloques FOR INSERT WITH CHECK (true);
CREATE POLICY "piso_bloques_update" ON public.piso_bloques FOR UPDATE USING (true);
CREATE POLICY "piso_bloques_delete" ON public.piso_bloques FOR DELETE USING (true);

-- 7. Columna-Bloques (asignación de bloques a columnas)
CREATE TABLE IF NOT EXISTS public.piso_columna_bloques (
  bloque_id UUID NOT NULL REFERENCES public.piso_bloques(id) ON DELETE CASCADE,
  columna_id UUID NOT NULL REFERENCES public.piso_columnas(id) ON DELETE CASCADE,
  PRIMARY KEY (bloque_id, columna_id)
);
ALTER TABLE public.piso_columna_bloques ENABLE ROW LEVEL SECURITY;
CREATE POLICY "piso_columna_bloques_select" ON public.piso_columna_bloques FOR SELECT USING (true);
CREATE POLICY "piso_columna_bloques_insert" ON public.piso_columna_bloques FOR INSERT WITH CHECK (true);
CREATE POLICY "piso_columna_bloques_delete" ON public.piso_columna_bloques FOR DELETE USING (true);

-- 8. Movimientos (cabecera de movimiento)
CREATE TABLE IF NOT EXISTS public.piso_movimientos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  numero_operacion SERIAL,
  tipo TEXT NOT NULL,          -- 'ingreso' | 'salida' | 'stock_inicial'
  fecha TIMESTAMPTZ DEFAULT now(),
  turno TEXT NOT NULL,         -- 'Día' | 'Noche'
  usuario_id UUID,
  usuario_nombre TEXT,
  usuario_correo TEXT
);
ALTER TABLE public.piso_movimientos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "piso_movimientos_select" ON public.piso_movimientos FOR SELECT USING (true);
CREATE POLICY "piso_movimientos_insert" ON public.piso_movimientos FOR INSERT WITH CHECK (true);
CREATE POLICY "piso_movimientos_delete" ON public.piso_movimientos FOR DELETE USING (true);

-- 9. Movimiento Detalles (qué bloque, en qué nivel, cuánta cantidad)
CREATE TABLE IF NOT EXISTS public.piso_movimiento_detalles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  movimiento_id UUID NOT NULL REFERENCES public.piso_movimientos(id) ON DELETE CASCADE,
  nivel_id UUID NOT NULL REFERENCES public.piso_niveles(id),
  bloque_id UUID NOT NULL REFERENCES public.piso_bloques(id),
  cantidad NUMERIC(14,3) NOT NULL DEFAULT 0
);
ALTER TABLE public.piso_movimiento_detalles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "piso_movimiento_detalles_select" ON public.piso_movimiento_detalles FOR SELECT USING (true);
CREATE POLICY "piso_movimiento_detalles_insert" ON public.piso_movimiento_detalles FOR INSERT WITH CHECK (true);
CREATE POLICY "piso_movimiento_detalles_delete" ON public.piso_movimiento_detalles FOR DELETE USING (true);

-- ═══════════════════════════════════════════════════════════════════
-- RPC: piso_registrar_movimiento
-- Crea un movimiento con sus detalles en una sola transacción
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.piso_registrar_movimiento(
  _tipo TEXT,
  _turno TEXT,
  _detalles JSONB DEFAULT '[]'::JSONB
)
RETURNS SETOF public.piso_movimientos
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_mov_id UUID;
  v_det JSONB;
BEGIN
  -- Crear cabecera del movimiento
  INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo)
  VALUES (
    _tipo,
    _turno,
    NULL,  -- se puede obtener del contexto de autenticación si se necesita
    NULL,
    NULL
  )
  RETURNING id INTO v_mov_id;

  -- Crear cada detalle
  FOR v_det IN SELECT * FROM jsonb_array_elements(_detalles)
  LOOP
    INSERT INTO public.piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad)
    VALUES (
      v_mov_id,
      (v_det->>'nivel_id')::UUID,
      (v_det->>'bloque_id')::UUID,
      COALESCE((v_det->>'cantidad')::NUMERIC, 0)
    );
  END LOOP;

  -- Retornar el movimiento creado
  RETURN QUERY SELECT * FROM public.piso_movimientos WHERE id = v_mov_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- TRIGGER: Auto-generar estructura cuando se crea un sector
-- Crea las columnas (A, B, C...), subcolumnas, posiciones y niveles
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.piso_auto_estructura_sector()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_col_idx INTEGER;
  v_sub_idx INTEGER;
  v_pos_idx INTEGER;
  v_niv_idx INTEGER;
  v_letra TEXT;
  v_sub_codigo TEXT;
  v_col_id UUID;
  v_sub_id UUID;
  v_pos_id UUID;
BEGIN
  -- Generar columnas (A, B, C, ...)
  FOR v_col_idx IN 1..NEW.n_columnas LOOP
    v_letra := CHR(64 + v_col_idx);  -- A=65, B=66, ...

    INSERT INTO public.piso_columnas (letra, sector_id)
    VALUES (v_letra, NEW.id)
    RETURNING id INTO v_col_id;

    -- Generar subcolumnas por cada columna
    FOR v_sub_idx IN 1..NEW.n_subcolumnas LOOP
      v_sub_codigo := NEW.prefijo || v_letra || v_sub_idx;

      INSERT INTO public.piso_subcolumnas (codigo, columna_id)
      VALUES (v_sub_codigo, v_col_id)
      RETURNING id INTO v_sub_id;

      -- Generar posiciones por cada subcolumna
      FOR v_pos_idx IN 1..NEW.n_posiciones LOOP
        INSERT INTO public.piso_posiciones (numero, subcolumna_id)
        VALUES (v_pos_idx, v_sub_id)
        RETURNING id INTO v_pos_id;

        -- Generar niveles por cada posición
        FOR v_niv_idx IN 1..NEW.n_niveles LOOP
          INSERT INTO public.piso_niveles (numero, posicion_id, codigo_ubicacion)
          VALUES (
            v_niv_idx,
            v_pos_id,
            v_sub_codigo || '-' || v_pos_idx || '-' || v_niv_idx
          );
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_piso_auto_estructura ON public.piso_sectores;
CREATE TRIGGER trg_piso_auto_estructura
  AFTER INSERT ON public.piso_sectores
  FOR EACH ROW
  EXECUTE FUNCTION public.piso_auto_estructura_sector();

-- ═══════════════════════════════════════════════════════════════════
-- Índices para mejorar rendimiento
-- ═══════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_piso_columnas_sector ON public.piso_columnas(sector_id);
CREATE INDEX IF NOT EXISTS idx_piso_subcolumnas_columna ON public.piso_subcolumnas(columna_id);
CREATE INDEX IF NOT EXISTS idx_piso_posiciones_subcolumna ON public.piso_posiciones(subcolumna_id);
CREATE INDEX IF NOT EXISTS idx_piso_niveles_posicion ON public.piso_niveles(posicion_id);
CREATE INDEX IF NOT EXISTS idx_piso_bloques_codigo ON public.piso_bloques(codigo);
CREATE INDEX IF NOT EXISTS idx_piso_movimientos_fecha ON public.piso_movimientos(fecha);
CREATE INDEX IF NOT EXISTS idx_piso_mov_detalles_movimiento ON public.piso_movimiento_detalles(movimiento_id);
CREATE INDEX IF NOT EXISTS idx_piso_mov_detalles_nivel ON public.piso_movimiento_detalles(nivel_id);
CREATE INDEX IF NOT EXISTS idx_piso_mov_detalles_bloque ON public.piso_movimiento_detalles(bloque_id);
CREATE INDEX IF NOT EXISTS idx_piso_col_bloques_columna ON public.piso_columna_bloques(columna_id);
