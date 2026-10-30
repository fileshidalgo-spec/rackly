-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — Permisos granulares por usuario (independientes del cargo/rol)
-- Fecha: 2026-10-31 · Módulo: Usuarios (transversal a todos los módulos)
--
-- Pedido del usuario:
--   "que los roles que yo tenga, se les pueda atribuir permiso para darles
--    permisos específicos por cada usuario, independientemente del cargo;
--    marcando qué es lo que pueden o no hacer dentro del app"
--
-- Diseño (defensa en profundidad, sin conflictos con lo existente):
--   1) public.user_permisos  → SOLO guarda OVERRIDES (excepciones al rol):
--        concedido = true  → el usuario PUEDE, aunque su rol no lo permita.
--        concedido = false → el usuario NO PUEDE, aunque su rol lo permita.
--      Sin fila = el permiso lo decide su rol (comportamiento actual intacto).
--   2) public.tiene_permiso(user, permiso) → fuente única de verdad:
--        admin → true SIEMPRE (un admin nunca pierde acceso: sin lockout)
--        override → su valor · sin override → valor por defecto del rol.
--   3) Políticas RLS DELETE ADITIVAS (OR) en 19 tablas → NUNCA restringen
--      lo que hoy funciona: el permiso solo AÑADE capacidad.
--   4) RPC establecer_permiso_usuario → única vía de escritura de overrides
--      (guard: service_role o quien tenga usuarios.gestionar_roles).
--      La tabla NO tiene políticas INSERT/UPDATE/DELETE: los clientes no
--      pueden escribir overrides directamente.
--   5) Guards de aprobar_usuario / cambiar_rol_usuario / eliminar_usuario
--      actualizados a permisos (FIX: la UI mostraba "Aprobar" a supervisores
--      pero la RPC los rechazaba — falso permiso UI/BD, bug real).
--
-- Catálogo de permisos (códigos espejo de src/lib/rackly/permisos.ts):
--   movimientos.eliminar · piso_movimientos.eliminar · recepcion.eliminar
--   atencion.eliminar · catalogo.editar · usuarios.aprobar · lote.editar
--   sectores.gestionar · usuarios.gestionar_roles · descarga.subir
-- (movimientos.eliminar cubre también el borrado de stock: eliminarUbicacion
--  borra de la tabla movimientos)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1 · TABLA user_permisos (solo overrides)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.user_permisos (
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  permiso     text        not null,
  concedido   boolean     not null,
  granted_by  uuid        references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, permiso)
);

alter table public.user_permisos enable row level security;

-- Índice de soporte para la lectura por permiso (user_id ya es PK-leading)
create index if not exists user_permisos_permiso_idx on public.user_permisos (permiso);

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · FUNCIÓN tiene_permiso (fuente única de verdad, STABLE = cacheable)
--     (se crea ANTES de las políticas que la referencian)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.tiene_permiso(p_user_id uuid, p_permiso text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- Admin: SIEMPRE todo (protección anti-lockout, no evalúa overrides)
    exists (
      select 1 from public.user_roles ur
      where ur.user_id = p_user_id and ur.role::text = 'admin'
    )
    or coalesce(
      -- Override explícito del usuario (gana sobre el rol)
      (
        select up.concedido
        from public.user_permisos up
        where up.user_id = p_user_id and up.permiso = p_permiso
        limit 1
      ),
      -- Defecto por rol: supervisores → permisos de supervisión
      exists (
        select 1 from public.user_roles ur
        where ur.user_id = p_user_id
          and ur.role::text = any (array[
            'supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones'
          ])
          and p_permiso = any (array[
            'movimientos.eliminar', 'piso_movimientos.eliminar', 'recepcion.eliminar',
            'atencion.eliminar', 'catalogo.editar', 'usuarios.aprobar'
          ])
      )
      -- Defecto por rol: lote.editar (ROLES_EDICION_LOTE)
      or exists (
        select 1 from public.user_roles ur
        where ur.user_id = p_user_id
          and ur.role::text = any (array['almacenero', 'supervisor_almacen', 'supervisor_operaciones'])
          and p_permiso = 'lote.editar'
      )
      -- Defecto por rol: descarga.subir (ROLES_UPDATA)
      or exists (
        select 1 from public.user_roles ur
        where ur.user_id = p_user_id
          and ur.role::text = 'coordinador_operaciones'
          and p_permiso = 'descarga.subir'
      )
    );
$$;

-- Lectura de overrides: el propio usuario ve los suyos; los gestores ven todos.
-- (tiene_permiso es SECURITY DEFINER → lee user_permisos sin recursión RLS)
drop policy if exists "user_permisos select propia o gestor" on public.user_permisos;
create policy "user_permisos select propia o gestor"
  on public.user_permisos
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.tiene_permiso(auth.uid(), 'usuarios.gestionar_roles')
  );
-- Sin políticas INSERT/UPDATE/DELETE: escritura SOLO vía RPC (paso 3).

-- ─────────────────────────────────────────────────────────────────────────
-- 3 · RPC establecer_permiso_usuario (única vía de escritura de overrides)
--     p_concedido = NULL → quita el override (vuelve al valor del rol)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.establecer_permiso_usuario(
  p_user_id   uuid,
  p_permiso   text,
  p_concedido boolean
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
      RAISE EXCEPTION 'NO_AUTORIZADO|Solo un administrador puede gestionar permisos';
    END IF;
  END IF;

  IF p_permiso IS NULL OR p_permiso NOT IN (
    'movimientos.eliminar', 'piso_movimientos.eliminar', 'recepcion.eliminar',
    'atencion.eliminar', 'catalogo.editar', 'usuarios.aprobar', 'lote.editar',
    'sectores.gestionar', 'usuarios.gestionar_roles', 'descarga.subir'
  ) THEN
    RAISE EXCEPTION 'PERMISO_DESCONOCIDO|El permiso % no existe en el catálogo', COALESCE(p_permiso, '(nulo)');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE|El perfil a modificar no existe';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p_user_id AND ur.role::text = 'admin'
  ) THEN
    RAISE EXCEPTION 'ADMIN_SIN_OVERRIDES|Los administradores ya tienen todos los permisos: no admiten excepciones';
  END IF;

  IF p_concedido IS NULL THEN
    DELETE FROM public.user_permisos
    WHERE user_id = p_user_id AND permiso = p_permiso;
  ELSE
    INSERT INTO public.user_permisos (user_id, permiso, concedido, granted_by)
    VALUES (p_user_id, p_permiso, p_concedido, auth.uid())
    ON CONFLICT (user_id, permiso)
    DO UPDATE SET
      concedido  = excluded.concedido,
      granted_by = excluded.granted_by,
      updated_at = now();
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4 · POLÍTICAS DELETE ADITIVAS (OR con las existentes: solo AÑADEN capacidad)
--     <tabla>_delete_permiso USING (public.tiene_permiso(auth.uid(), <permiso>))
-- ─────────────────────────────────────────────────────────────────────────
drop policy if exists "movimientos_delete_permiso" on public.movimientos;
create policy "movimientos_delete_permiso" on public.movimientos
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'movimientos.eliminar'));

drop policy if exists "piso_movimientos_delete_permiso" on public.piso_movimientos;
create policy "piso_movimientos_delete_permiso" on public.piso_movimientos
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'piso_movimientos.eliminar'));

drop policy if exists "piso_movimiento_detalles_delete_permiso" on public.piso_movimiento_detalles;
create policy "piso_movimiento_detalles_delete_permiso" on public.piso_movimiento_detalles
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'piso_movimientos.eliminar'));

drop policy if exists "recepcion_registros_delete_permiso" on public.recepcion_registros;
create policy "recepcion_registros_delete_permiso" on public.recepcion_registros
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'recepcion.eliminar'));

drop policy if exists "atencion_registros_delete_permiso" on public.atencion_registros;
create policy "atencion_registros_delete_permiso" on public.atencion_registros
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "rals_delete_permiso" on public.rals;
create policy "rals_delete_permiso" on public.rals
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "ral_items_delete_permiso" on public.ral_items;
create policy "ral_items_delete_permiso" on public.ral_items
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "rq_atenciones_delete_permiso" on public.rq_atenciones;
create policy "rq_atenciones_delete_permiso" on public.rq_atenciones
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "rq_atencion_items_delete_permiso" on public.rq_atencion_items;
create policy "rq_atencion_items_delete_permiso" on public.rq_atencion_items
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "rq_atencion_tomas_delete_permiso" on public.rq_atencion_tomas;
create policy "rq_atencion_tomas_delete_permiso" on public.rq_atencion_tomas
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "catalogo_delete_permiso" on public.catalogo;
create policy "catalogo_delete_permiso" on public.catalogo
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'catalogo.editar'));

-- Estructura del piso (SectoresTab gestionaba bloques/columnas/niveles/…)
drop policy if exists "piso_sectores_delete_permiso" on public.piso_sectores;
create policy "piso_sectores_delete_permiso" on public.piso_sectores
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_bloques_delete_permiso" on public.piso_bloques;
create policy "piso_bloques_delete_permiso" on public.piso_bloques
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_columnas_delete_permiso" on public.piso_columnas;
create policy "piso_columnas_delete_permiso" on public.piso_columnas
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_columna_bloques_delete_permiso" on public.piso_columna_bloques;
create policy "piso_columna_bloques_delete_permiso" on public.piso_columna_bloques
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_niveles_delete_permiso" on public.piso_niveles;
create policy "piso_niveles_delete_permiso" on public.piso_niveles
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_posiciones_delete_permiso" on public.piso_posiciones;
create policy "piso_posiciones_delete_permiso" on public.piso_posiciones
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_subcolumnas_delete_permiso" on public.piso_subcolumnas;
create policy "piso_subcolumnas_delete_permiso" on public.piso_subcolumnas
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

-- ─────────────────────────────────────────────────────────────────────────
-- 5 · GUARDS DE RPCs EXISTENTES → permisos (mismo patrón, misma firma)
--     FIX bug real: la UI mostraba "Aprobar" a supervisores pero la RPC
--     los rechazaba. Ahora UI y BD comparten la misma regla.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.aprobar_usuario(p_user_id uuid, p_aprobado boolean)
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
       OR NOT public.tiene_permiso(auth.uid(), 'usuarios.aprobar') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para aprobar usuarios';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE|El perfil a modificar no existe';
  END IF;

  -- Protección (nueva): el estado de acceso PROPIO no se toca desde la RPC —
  --   · revocarse a sí mismo = auto-bloqueo (requeriría fix manual en BD);
  --   · aprobarse a sí mismo = saltarse la aprobación del administrador.
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'OPERACION_INVALIDA|No puedes cambiar tu propio estado de acceso';
  END IF;

  UPDATE public.profiles SET aprobado = p_aprobado WHERE id = p_user_id;
END;
$$;

create or replace function public.cambiar_rol_usuario(p_user_id uuid, p_rol app_role)
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
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para cambiar roles';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE|El usuario a modificar no existe';
  END IF;

  DELETE FROM public.user_roles WHERE user_id = p_user_id;
  INSERT INTO public.user_roles (user_id, role) VALUES (p_user_id, p_rol);
END;
$$;

create or replace function public.eliminar_usuario(p_user_id uuid)
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
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para eliminar usuarios';
    END IF;
  END IF;

  -- Protección mínima (original): un gestor no puede eliminarse a sí mismo
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'OPERACION_INVALIDA|Un administrador no puede eliminar su propio usuario';
  END IF;

  -- (cuerpo original: borra filas de BD; el usuario Auth se elimina por la
  --  Edge Function gestionar-usuario-auth, que exige sesión admin activa)
  DELETE FROM public.user_roles WHERE user_id = p_user_id;
  DELETE FROM public.profiles WHERE id = p_user_id;
END;
$$;
