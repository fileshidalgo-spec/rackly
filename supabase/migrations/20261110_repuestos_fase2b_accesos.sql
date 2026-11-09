-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · Migración 20261110b — REPUESTOS: accesos por almacén + limpieza
--
-- 1) LIMPIEZA de los datos de prueba de la Fase 2 (TEST-001, ubicación
--    TEST-P1-N1-P01 con piso 99): borra stock → movimientos → artículos →
--    ubicaciones (las loncheras caen en cascada). Deja las tablas rep_*
--    vacías y listas para producción.
--
-- 2) CAMPO "ALMACENES AUTORIZADOS" (acordado): el acceso a cada almacén
--    se controla por usuario, independiente de los permisos de módulo:
--      · profiles.acceso_insumos   (default TRUE  — nadie pierde acceso hoy)
--      · profiles.acceso_repuestos (default FALSE — alta controlada por admin)
--    El admin lo alterna en el módulo Usuarios vía la RPC SECURITY DEFINER
--    `establecer_acceso_almacen` (mismo guard que cambiar_rol_usuario).
--
-- 100% ADITIVA para Insumos: nadie cambia de almacén por defecto y las
-- pantallas/flujo actuales no se tocan.
-- ═══════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1) LIMPIEZA de datos de prueba
-- ────────────────────────────────────────────────────────────────────
delete from public.rep_stock
where articulo_id in (select id from public.rep_articulos where codigo = 'TEST-001');

delete from public.rep_movimientos
where articulo_id in (select id from public.rep_articulos where codigo = 'TEST-001');

delete from public.rep_articulos where codigo = 'TEST-001';

-- La ubicación de prueba: borra stock/movs restantes por si acaso y luego la
-- ubicación (rep_loncheras y rep_stock caen por ON DELETE CASCADE).
delete from public.rep_movimientos
where origen_ubicacion_id in (select id from public.rep_ubicaciones where codigo = 'TEST-P1-N1-P01')
   or destino_ubicacion_id in (select id from public.rep_ubicaciones where codigo = 'TEST-P1-N1-P01');

delete from public.rep_ubicaciones where codigo = 'TEST-P1-N1-P01';

-- ────────────────────────────────────────────────────────────────────
-- 2) ACCESO POR ALMACÉN (profiles)
-- ────────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists acceso_insumos boolean not null default true;
alter table public.profiles
  add column if not exists acceso_repuestos boolean not null default false;

comment on column public.profiles.acceso_insumos is
  'Almacenes autorizados: puede entrar al almacén INSUMOS (default true: comportamiento histórico).';
comment on column public.profiles.acceso_repuestos is
  'Almacenes autorizados: puede entrar al almacén REPUESTOS (default false: alta controlada por admin).';

-- RPC SECURITY DEFINER — mismo guard que cambiar_rol_usuario (20261016):
-- service_role o usuario autenticado con usuarios.gestionar_roles (admin).
create or replace function public.establecer_acceso_almacen(
  p_user_id uuid,
  p_almacen text,
  p_acceso  boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL; -- la app (service_role): permitido
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'usuarios.gestionar_roles') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|Solo un administrador puede cambiar accesos a almacenes';
    END IF;
  END IF;

  IF p_almacen NOT IN ('insumos', 'repuestos') THEN
    RAISE EXCEPTION 'ALMACEN_DESCONOCIDO|El almacén % no existe', COALESCE(p_almacen, '(nulo)');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE|El perfil a modificar no existe';
  END IF;

  UPDATE public.profiles
     SET acceso_insumos   = CASE WHEN p_almacen = 'insumos'   THEN p_acceso ELSE acceso_insumos   END,
         acceso_repuestos = CASE WHEN p_almacen = 'repuestos' THEN p_acceso ELSE acceso_repuestos END
   WHERE id = p_user_id;
END;
$$;

-- El propio usuario NO puede bloquearse el acceso a sí mismo con esta RPC
-- (la política UPDATE de profiles solo permite tocar must_change_password:
-- defensa extra; esta RPC además exige usuarios.gestionar_roles = admin).

grant execute on function public.establecer_acceso_almacen(uuid, text, boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- Verificación post-aplicación:
--   select codigo from rep_articulos;                       → 0 filas
--   select codigo from rep_ubicaciones;                     → 0 filas
--   select column_name from information_schema.columns
--     where table_name='profiles' and column_name like 'acceso%';  → 2 filas
-- ═══════════════════════════════════════════════════════════════════
