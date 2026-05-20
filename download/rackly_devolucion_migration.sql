-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN: Agregar tipo 'devolucion' a movimientos
-- Ejecutar en Supabase Dashboard > SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- 1. Actualizar constraint CHECK para aceptar 'devolucion'
ALTER TABLE public.movimientos DROP CONSTRAINT IF EXISTS movimientos_tipo_check;
ALTER TABLE public.movimientos ADD CONSTRAINT movimientos_tipo_check 
  CHECK (tipo IN ('ingreso','salida','devolucion'));

-- 2. Actualizar función stock_en_ubicacion 
-- (devolución suma al stock, igual que ingreso)
CREATE OR REPLACE FUNCTION public.stock_en_ubicacion(
  _bloque TEXT,
  _torre TEXT,
  _piso TEXT,
  _posicion TEXT
)
RETURNS TABLE(
  codigo TEXT,
  descripcion TEXT,
  un TEXT,
  stock NUMERIC,
  f_vencimiento DATE,
  usuario_primer_nombre TEXT,
  proveedor TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 
    m.codigo,
    MAX(m.descripcion) AS descripcion,
    MAX(m.un) AS un,
    SUM(
      CASE 
        WHEN m.tipo IN ('ingreso', 'devolucion') THEN m.cantidad 
        WHEN m.tipo = 'salida' THEN -m.cantidad 
        ELSE 0 
      END
    ) AS stock,
    (
      -- Tomar el vencimiento del ingreso/devolución más reciente
      SELECT m2.f_vencimiento
      FROM public.movimientos m2
      WHERE m2.bloque = m.bloque 
        AND m2.torre = m.torre 
        AND m2.piso = m.piso 
        AND m2.posicion = m.posicion 
        AND m2.codigo = m.codigo
        AND m2.tipo IN ('ingreso', 'devolucion')
      ORDER BY m2.f_modificacion DESC
      LIMIT 1
    ) AS f_vencimiento,
    (
      -- Tomar el nombre del usuario del primer movimiento
      SELECT m3.usuario_nombre
      FROM public.movimientos m3
      WHERE m3.bloque = m.bloque 
        AND m3.torre = m.torre 
        AND m3.piso = m.piso 
        AND m3.posicion = m.posicion 
        AND m3.codigo = m.codigo
      ORDER BY m3.f_modificacion ASC
      LIMIT 1
    ) AS usuario_primer_nombre,
    (
      -- Tomar proveedor del movimiento más reciente que tenga uno
      SELECT m4.proveedor
      FROM public.movimientos m4
      WHERE m4.bloque = m.bloque 
        AND m4.torre = m.torre 
        AND m4.piso = m.piso 
        AND m4.posicion = m.posicion 
        AND m4.codigo = m.codigo
        AND m4.proveedor IS NOT NULL AND m4.proveedor != ''
      ORDER BY m4.f_modificacion DESC
      LIMIT 1
    ) AS proveedor
  FROM public.movimientos m
  WHERE m.bloque = _bloque
    AND m.torre = _torre
    AND m.piso = _piso
    AND m.posicion = _posicion
  GROUP BY m.bloque, m.torre, m.piso, m.posicion, m.codigo
  HAVING SUM(
    CASE 
      WHEN m.tipo IN ('ingreso', 'devolucion') THEN m.cantidad 
      WHEN m.tipo = 'salida' THEN -m.cantidad 
      ELSE 0 
    END
  ) > 0
  ORDER BY m.codigo;
$$;

-- 3. Actualizar función ocupacion_celdas
-- (devolución suma al stock, igual que ingreso)
CREATE OR REPLACE FUNCTION public.ocupacion_celdas()
RETURNS TABLE(
  bloque TEXT,
  torre TEXT,
  piso TEXT,
  posicion TEXT,
  stock NUMERIC,
  codigos TEXT[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 
    m.bloque,
    m.torre,
    m.piso,
    m.posicion,
    SUM(
      CASE 
        WHEN m.tipo IN ('ingreso', 'devolucion') THEN m.cantidad 
        WHEN m.tipo = 'salida' THEN -m.cantidad 
        ELSE 0 
      END
    ) AS stock,
    ARRAY_AGG(DISTINCT m.codigo) AS codigos
  FROM public.movimientos m
  GROUP BY m.bloque, m.torre, m.piso, m.posicion
  HAVING SUM(
    CASE 
      WHEN m.tipo IN ('ingreso', 'devolucion') THEN m.cantidad 
      WHEN m.tipo = 'salida' THEN -m.cantidad 
      ELSE 0 
    END
  ) > 0;
$$;
