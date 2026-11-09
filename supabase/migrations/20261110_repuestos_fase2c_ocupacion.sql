-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · Migración 20261110c — REPUESTOS: ocupación agregada del mapa
--
-- La vista de Ubicaciones pinta la ocupación de CADA lonchera (nº de
-- artículos distintos, cantidad total, artículos estacionados en
-- tránsito). Traer todas las filas de rep_stock al navegador y agregar
-- en cliente no escala: esta RPC hace el GROUP BY en BD y devuelve UNA
-- fila por lonchera CON stock.
--
-- 100% ADITIVA: no toca tablas, políticas ni funciones existentes.
-- SECURITY INVOKER (default): las políticas RLS de rep_stock del caller
-- siguen aplicando — quien no puede ver stock, no ve ocupación.
-- ═══════════════════════════════════════════════════════════════════

create or replace function public.rep_ocupacion_loncheras()
returns table (
  lonchera_id  uuid,
  articulos    bigint,
  cantidad     numeric,
  en_transito  bigint
)
language sql
stable
set search_path = public
as $$
  select
    s.lonchera_id,
    count(*)::bigint                        as articulos,
    coalesce(sum(s.cantidad), 0)::numeric   as cantidad,
    count(s.ral_id)::bigint                 as en_transito
  from public.rep_stock s
  group by s.lonchera_id
$$;

grant execute on function public.rep_ocupacion_loncheras() to authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- Verificación post-aplicación:
--   select * from rep_ocupacion_loncheras();  → 0 filas (tablas vacías)
-- ═══════════════════════════════════════════════════════════════════
