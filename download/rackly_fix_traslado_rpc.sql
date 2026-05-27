-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN: Incluir 'traslado' en funciones RPC de stock
-- Ejecutar en Supabase Dashboard > SQL Editor
-- ═══════════════════════════════════════════════════════════════
-- Problema: Las funciones RPC 'ocupacion_celdas' y 'stock_en_ubicacion'
-- no incluían el tipo 'traslado' en su cálculo de stock.
-- Cuando un artículo se movía por traslado a una ubicación, esa ubicación
-- mostraba stock = 0 (color verde = vacío) en el grid de Ocupación.
-- 
-- El frontend ya fue corregido para calcular la ocupación directamente
-- desde los movimientos, pero estas funciones RPC deben actualizarse
-- para consistencia futura y como fallback.
-- ═══════════════════════════════════════════════════════════════

-- 1. Actualizar stock_en_ubicacion para incluir 'traslado'
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
        WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad 
        WHEN m.tipo = 'salida' THEN -m.cantidad 
        ELSE 0 
      END
    ) AS stock,
    (
      SELECT m2.f_vencimiento
      FROM public.movimientos m2
      WHERE m2.bloque = m.bloque 
        AND m2.torre = m.torre 
        AND m2.piso = m.piso 
        AND m2.posicion = m.posicion 
        AND m2.codigo = m.codigo
        AND m2.tipo IN ('ingreso', 'devolucion', 'traslado')
      ORDER BY m2.f_modificacion DESC
      LIMIT 1
    ) AS f_vencimiento,
    (
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
      WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad 
      WHEN m.tipo = 'salida' THEN -m.cantidad 
      ELSE 0 
    END
  ) > 0
  ORDER BY m.codigo;
$$;

-- 2. Actualizar ocupacion_celdas para incluir 'traslado'
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
        WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad 
        WHEN m.tipo = 'salida' THEN -m.cantidad 
        ELSE 0 
      END
    ) AS stock,
    ARRAY_AGG(DISTINCT m.codigo) AS codigos
  FROM public.movimientos m
  GROUP BY m.bloque, m.torre, m.piso, m.posicion
  HAVING SUM(
    CASE 
      WHEN m.tipo IN ('ingreso', 'devolucion', 'traslado') THEN m.cantidad 
      WHEN m.tipo = 'salida' THEN -m.cantidad 
      ELSE 0 
    END
  ) > 0;
$$;
