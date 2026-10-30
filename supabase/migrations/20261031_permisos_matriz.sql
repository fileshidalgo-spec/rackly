-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — CUADRO DE PERMISOS por módulo × acción (v2 de permisos por usuario)
-- Fecha: 2026-10-31 · Módulo: Usuarios (transversal)
--
-- Problema corregido (audit 2026-10-31):
--   1. Negar NO funcionaba en BD: las políticas *_delete_permiso son PERMISSIVE
--      (OR con las de rol) → un supervisor con override ✗ seguía borrando.
--   2. El catálogo solo cubría acciones de eliminar: faltaba la matriz
--      Ver / Crear / Editar / Eliminar / Aprobar por módulo.
--   3. 14 RPCs SECURITY DEFINER saltaban RLS: ningún override las bloqueaba.
--   4. RqDetalle usaba «atencion.eliminar» para EDITAR (falso permiso).
--
-- Diseño (dos capas, cero conflictos con lo existente):
--   · GRANT (ya existía): políticas PERMISSIVE de rol + *_permiso (OR).
--     No se tocan: con cero overrides todo sigue EXACTAMENTE igual.
--   · DENY (nueva): políticas AS RESTRICTIVE que se AND-ean con las
--     permissive. Evalúan tiene_permiso(), que con override negativo da false
--     y bloquea AUNQUE el rol conceda. Defaults = comportamiento actual.
--
-- CUADRO (27 permisos — espejo de src/lib/rackly/permisos.ts):
--   Módulo        Ver                Crear                Editar                Eliminar                 Aprobar
--   Racks         racks.ver          movimientos.crear    lote.editar           movimientos.eliminar     —
--   Catálogo      catalogo.ver       catalogo.crear       catalogo.editar       catalogo.eliminar        —
--   Descarga      —                  descarga.subir       —                     —                        —
--   Piso          piso.ver           piso_movimientos.crear  sectores.gestionar  piso_movimientos.eliminar —
--   Recepción     recepcion.ver      recepcion.crear      recepcion.editar      recepcion.eliminar       —
--   Atención      atencion.ver       atencion.crear       atencion.editar       atencion.eliminar        —
--   Tránsito      transito.ver       transito.crear       —                     —                        —
--   Usuarios      usuarios.ver       —                    usuarios.gestionar_roles  usuarios.eliminar    usuarios.aprobar
--
-- DEFAULTS por rol (reproducen el comportamiento de HOY, verificado contra
-- pg_policies y los gates de UI existentes):
--   · ver / crear / recepcion.editar / atencion.editar → TODOS los roles.
--   · catalogo.crear/editar/eliminar, movimientos/piso_movimientos/
--     recepcion/atencion.eliminar, usuarios.aprobar → supervisores+.
--   · lote.editar → almacenero + supervisores (ROLES_EDICION_LOTE).
--   · descarga.subir → coordinador_operaciones (ROLES_UPDATA).
--   · sectores.gestionar, usuarios.gestionar_roles, usuarios.eliminar → admin.
--   · admin → SIEMPRE todo (anti-lockout, ignora overrides).
--
-- UNIONES explícitas (flujos legítimos que escriben/leen con otro permiso):
--   · movimientos INSERT ∪ descarga.subir   (UP Data inserta en lote)
--   · recepcion SELECT ∪ transito.ver       (Tránsito lee las guías)
--   · recepcion UPDATE ∪ recepcion.crear y atención UPDATE ∪ atencion.crear
--     (los flujos de atender/imprimir actualizan estado; el contenido lo
--      protege la UI + los guards de las RPCs de edición)
--   · Llamadas anidadas entre RPCs (transito→registrar_movimiento_kardex)
--     heredan la autorización de la RPC externa (GUC rackly.en_rpc_interna).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1 · DEFAULTS DEL CUADRO: permiso_defecto_rol(rol, permiso)
--     (espejo EXACTO de rolConcedePermiso() en src/lib/rackly/permisos.ts)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.permiso_defecto_rol(p_rol text, p_permiso text)
returns boolean
language sql
stable
set search_path = public
as $$
  select case
    -- VER: todos los roles (comportamiento actual de las políticas SELECT)
    when p_permiso in ('racks.ver', 'piso.ver', 'recepcion.ver', 'atencion.ver',
                       'transito.ver', 'catalogo.ver', 'usuarios.ver')
      then true
    -- CREAR: todos los roles (comportamiento actual de las políticas INSERT)
    when p_permiso in ('movimientos.crear', 'piso_movimientos.crear', 'recepcion.crear',
                       'atencion.crear', 'transito.crear')
      then true
    -- EDITAR de recepción/atención: todos los roles (hoy así en BD y UI)
    when p_permiso in ('recepcion.editar', 'atencion.editar')
      then true
    -- Catálogo: supervisores+ (la UI ya ocultaba la edición al resto)
    when p_permiso in ('catalogo.crear', 'catalogo.editar', 'catalogo.eliminar')
      then p_rol in ('supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones')
    -- Eliminaciones operativas: supervisores+ (igual que hoy)
    when p_permiso in ('movimientos.eliminar', 'piso_movimientos.eliminar',
                       'recepcion.eliminar', 'atencion.eliminar')
      then p_rol in ('supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones')
    -- lote.editar: almacenero + supervisores (ROLES_EDICION_LOTE, v2 del 20-10)
    when p_permiso = 'lote.editar'
      then p_rol in ('almacenero', 'supervisor_almacen', 'supervisor_operaciones')
    -- descarga.subir: coordinador (ROLES_UPDATA)
    when p_permiso = 'descarga.subir'
      then p_rol = 'coordinador_operaciones'
    -- sectores.gestionar / usuarios.gestionar_roles / usuarios.eliminar:
    -- solo admin (lo resuelve la rama admin de tiene_permiso; false aquí)
    when p_permiso in ('sectores.gestionar', 'usuarios.gestionar_roles', 'usuarios.eliminar')
      then false
    -- usuarios.aprobar: supervisores+ (default de la UI)
    when p_permiso = 'usuarios.aprobar'
      then p_rol in ('supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones')
    else false
  end
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · tiene_permiso() v2: admin → true · override → su valor · defecto → cuadro
--     (misma semántica de la v1; amplía los defaults al cuadro completo)
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
      -- Override explícito del usuario (gana sobre el rol, en ambos sentidos)
      (
        select up.concedido
        from public.user_permisos up
        where up.user_id = p_user_id and up.permiso = p_permiso
        limit 1
      ),
      -- Defecto del cuadro según el rol del usuario
      exists (
        select 1 from public.user_roles ur
        where ur.user_id = p_user_id
          and public.permiso_defecto_rol(ur.role::text, p_permiso)
      )
    )
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3 · RPC establecer_permiso_usuario v2 (catálogo del cuadro: 26 permisos)
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
    -- Ver
    'racks.ver', 'piso.ver', 'recepcion.ver', 'atencion.ver',
    'transito.ver', 'catalogo.ver', 'usuarios.ver',
    -- Crear
    'movimientos.crear', 'piso_movimientos.crear', 'recepcion.crear',
    'atencion.crear', 'transito.crear', 'catalogo.crear', 'descarga.subir',
    -- Editar
    'recepcion.editar', 'atencion.editar', 'lote.editar',
    'sectores.gestionar', 'catalogo.editar', 'usuarios.gestionar_roles',
    -- Eliminar
    'movimientos.eliminar', 'piso_movimientos.eliminar', 'recepcion.eliminar',
    'atencion.eliminar', 'catalogo.eliminar', 'usuarios.eliminar',
    -- Aprobar
    'usuarios.aprobar'
  ) THEN
    RAISE EXCEPTION 'PERMISO_DESCONOCIDO|El permiso % no existe en el cuadro', COALESCE(p_permiso, '(nulo)');
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
-- 4 · eliminar_usuario: guard → usuarios.eliminar (celda «Eliminar» de Usuarios)
--     (antes exigía usuarios.gestionar_roles; mismo efecto con defaults,
--      pero ahora el cuadro lo controla por separado)
-- ─────────────────────────────────────────────────────────────────────────
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
       OR NOT public.tiene_permiso(auth.uid(), 'usuarios.eliminar') THEN
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

-- ─────────────────────────────────────────────────────────────────────────
-- 5 · POLÍTICAS RESTRICTIVE — la capa DENY del cuadro
--     Se AND-ean con las permissive existentes (que NO se tocan):
--       · defaults → true para el rol → cero cambio de comportamiento.
--       · override ✗ → false → BLOQUEA aunque el rol conceda (FIX).
-- ─────────────────────────────────────────────────────────────────────────

-- ── 5.1 VER (SELECT) ──────────────────────────────────────────────────────
drop policy if exists "movimientos_ver_restr" on public.movimientos;
create policy "movimientos_ver_restr" on public.movimientos
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'racks.ver'));

drop policy if exists "piso_movimientos_ver_restr" on public.piso_movimientos;
create policy "piso_movimientos_ver_restr" on public.piso_movimientos
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'piso.ver'));

drop policy if exists "piso_mov_detalles_ver_restr" on public.piso_movimiento_detalles;
create policy "piso_mov_detalles_ver_restr" on public.piso_movimiento_detalles
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'piso.ver'));

drop policy if exists "recepcion_ver_restr" on public.recepcion_registros;
create policy "recepcion_ver_restr" on public.recepcion_registros
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'recepcion.ver') or public.tiene_permiso(auth.uid(), 'transito.ver'));

drop policy if exists "rq_atenciones_ver_restr" on public.rq_atenciones;
create policy "rq_atenciones_ver_restr" on public.rq_atenciones
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.ver'));

drop policy if exists "rq_atencion_items_ver_restr" on public.rq_atencion_items;
create policy "rq_atencion_items_ver_restr" on public.rq_atencion_items
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.ver'));

drop policy if exists "rq_atencion_tomas_ver_restr" on public.rq_atencion_tomas;
create policy "rq_atencion_tomas_ver_restr" on public.rq_atencion_tomas
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.ver'));

drop policy if exists "atencion_registros_ver_restr" on public.atencion_registros;
create policy "atencion_registros_ver_restr" on public.atencion_registros
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.ver'));

drop policy if exists "rals_ver_restr" on public.rals;
create policy "rals_ver_restr" on public.rals
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.ver'));

drop policy if exists "ral_items_ver_restr" on public.ral_items;
create policy "ral_items_ver_restr" on public.ral_items
  as restrictive for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.ver'));

-- ── 5.2 CREAR (INSERT) ───────────────────────────────────────────────────
drop policy if exists "movimientos_crear_restr" on public.movimientos;
create policy "movimientos_crear_restr" on public.movimientos
  as restrictive for insert to authenticated
  with check (
    public.tiene_permiso(auth.uid(), 'movimientos.crear')
    or public.tiene_permiso(auth.uid(), 'descarga.subir')  -- UP Data inserta en lote
  );

drop policy if exists "catalogo_crear_restr" on public.catalogo;
create policy "catalogo_crear_restr" on public.catalogo
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'catalogo.crear'));

drop policy if exists "piso_movimientos_crear_restr" on public.piso_movimientos;
create policy "piso_movimientos_crear_restr" on public.piso_movimientos
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'piso_movimientos.crear'));

drop policy if exists "piso_mov_detalles_crear_restr" on public.piso_movimiento_detalles;
create policy "piso_mov_detalles_crear_restr" on public.piso_movimiento_detalles
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'piso_movimientos.crear'));

drop policy if exists "recepcion_crear_restr" on public.recepcion_registros;
create policy "recepcion_crear_restr" on public.recepcion_registros
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'recepcion.crear'));

drop policy if exists "rq_atenciones_crear_restr" on public.rq_atenciones;
create policy "rq_atenciones_crear_restr" on public.rq_atenciones
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'atencion.crear'));

drop policy if exists "rq_atencion_items_crear_restr" on public.rq_atencion_items;
create policy "rq_atencion_items_crear_restr" on public.rq_atencion_items
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'atencion.crear'));

drop policy if exists "rq_atencion_tomas_crear_restr" on public.rq_atencion_tomas;
create policy "rq_atencion_tomas_crear_restr" on public.rq_atencion_tomas
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'atencion.crear'));

drop policy if exists "atencion_registros_crear_restr" on public.atencion_registros;
create policy "atencion_registros_crear_restr" on public.atencion_registros
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'atencion.crear'));

drop policy if exists "rals_crear_restr" on public.rals;
create policy "rals_crear_restr" on public.rals
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'atencion.crear'));

drop policy if exists "ral_items_crear_restr" on public.ral_items;
create policy "ral_items_crear_restr" on public.ral_items
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'atencion.crear'));

-- ── 5.3 EDITAR (UPDATE) ──────────────────────────────────────────────────
-- Recepción/Atención: unión con .crear — los flujos de atender/imprimir
-- actualizan estado sin ser «edición de contenido» (esa la protege la UI +
-- los guards de las RPCs rq_editar_rq / rq_atender_lote).
drop policy if exists "catalogo_editar_restr" on public.catalogo;
create policy "catalogo_editar_restr" on public.catalogo
  as restrictive for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'catalogo.editar'))
  with check (public.tiene_permiso(auth.uid(), 'catalogo.editar'));

drop policy if exists "recepcion_editar_restr" on public.recepcion_registros;
create policy "recepcion_editar_restr" on public.recepcion_registros
  as restrictive for update to authenticated
  using (
    public.tiene_permiso(auth.uid(), 'recepcion.editar')
    or public.tiene_permiso(auth.uid(), 'recepcion.crear')
  )
  with check (
    public.tiene_permiso(auth.uid(), 'recepcion.editar')
    or public.tiene_permiso(auth.uid(), 'recepcion.crear')
  );

drop policy if exists "rq_atenciones_editar_restr" on public.rq_atenciones;
create policy "rq_atenciones_editar_restr" on public.rq_atenciones
  as restrictive for update to authenticated
  using (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  )
  with check (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  );

drop policy if exists "rq_atencion_items_editar_restr" on public.rq_atencion_items;
create policy "rq_atencion_items_editar_restr" on public.rq_atencion_items
  as restrictive for update to authenticated
  using (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  )
  with check (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  );

drop policy if exists "rq_atencion_tomas_editar_restr" on public.rq_atencion_tomas;
create policy "rq_atencion_tomas_editar_restr" on public.rq_atencion_tomas
  as restrictive for update to authenticated
  using (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  )
  with check (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  );

drop policy if exists "atencion_registros_editar_restr" on public.atencion_registros;
create policy "atencion_registros_editar_restr" on public.atencion_registros
  as restrictive for update to authenticated
  using (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  )
  with check (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  );

drop policy if exists "rals_editar_restr" on public.rals;
create policy "rals_editar_restr" on public.rals
  as restrictive for update to authenticated
  using (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  )
  with check (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  );

drop policy if exists "ral_items_editar_restr" on public.ral_items;
create policy "ral_items_editar_restr" on public.ral_items
  as restrictive for update to authenticated
  using (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  )
  with check (
    public.tiene_permiso(auth.uid(), 'atencion.editar')
    or public.tiene_permiso(auth.uid(), 'atencion.crear')
  );

-- Estructura del piso: sectores.gestionar (la UI ya la reservaba al admin)
drop policy if exists "piso_sectores_editar_restr" on public.piso_sectores;
create policy "piso_sectores_editar_restr" on public.piso_sectores
  as restrictive for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_bloques_editar_restr" on public.piso_bloques;
create policy "piso_bloques_editar_restr" on public.piso_bloques
  as restrictive for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_columnas_editar_restr" on public.piso_columnas;
create policy "piso_columnas_editar_restr" on public.piso_columnas
  as restrictive for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_niveles_editar_restr" on public.piso_niveles;
create policy "piso_niveles_editar_restr" on public.piso_niveles
  as restrictive for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_posiciones_editar_restr" on public.piso_posiciones;
create policy "piso_posiciones_editar_restr" on public.piso_posiciones
  as restrictive for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_subcolumnas_editar_restr" on public.piso_subcolumnas;
create policy "piso_subcolumnas_editar_restr" on public.piso_subcolumnas
  as restrictive for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

-- ── 5.4 ELIMINAR (DELETE) — FIX principal: el override ✗ ahora BLOQUEA
--     aunque la política de rol (permissive) siga concediendo ──────────────
drop policy if exists "movimientos_delete_restr" on public.movimientos;
create policy "movimientos_delete_restr" on public.movimientos
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'movimientos.eliminar'));

drop policy if exists "piso_movimientos_delete_restr" on public.piso_movimientos;
create policy "piso_movimientos_delete_restr" on public.piso_movimientos
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'piso_movimientos.eliminar'));

drop policy if exists "piso_mov_detalles_delete_restr" on public.piso_movimiento_detalles;
create policy "piso_mov_detalles_delete_restr" on public.piso_movimiento_detalles
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'piso_movimientos.eliminar'));

drop policy if exists "recepcion_delete_restr" on public.recepcion_registros;
create policy "recepcion_delete_restr" on public.recepcion_registros
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'recepcion.eliminar'));

drop policy if exists "rq_atenciones_delete_restr" on public.rq_atenciones;
create policy "rq_atenciones_delete_restr" on public.rq_atenciones
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "rq_atencion_items_delete_restr" on public.rq_atencion_items;
create policy "rq_atencion_items_delete_restr" on public.rq_atencion_items
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "rq_atencion_tomas_delete_restr" on public.rq_atencion_tomas;
create policy "rq_atencion_tomas_delete_restr" on public.rq_atencion_tomas
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "atencion_registros_delete_restr" on public.atencion_registros;
create policy "atencion_registros_delete_restr" on public.atencion_registros
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "rals_delete_restr" on public.rals;
create policy "rals_delete_restr" on public.rals
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "ral_items_delete_restr" on public.ral_items;
create policy "ral_items_delete_restr" on public.ral_items
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'atencion.eliminar'));

drop policy if exists "catalogo_delete_restr" on public.catalogo;
create policy "catalogo_delete_restr" on public.catalogo
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'catalogo.eliminar'));

drop policy if exists "piso_sectores_delete_restr" on public.piso_sectores;
create policy "piso_sectores_delete_restr" on public.piso_sectores
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_bloques_delete_restr" on public.piso_bloques;
create policy "piso_bloques_delete_restr" on public.piso_bloques
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_columnas_delete_restr" on public.piso_columnas;
create policy "piso_columnas_delete_restr" on public.piso_columnas
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_columna_bloques_delete_restr" on public.piso_columna_bloques;
create policy "piso_columna_bloques_delete_restr" on public.piso_columna_bloques
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_niveles_delete_restr" on public.piso_niveles;
create policy "piso_niveles_delete_restr" on public.piso_niveles
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_posiciones_delete_restr" on public.piso_posiciones;
create policy "piso_posiciones_delete_restr" on public.piso_posiciones
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_subcolumnas_delete_restr" on public.piso_subcolumnas;
create policy "piso_subcolumnas_delete_restr" on public.piso_subcolumnas
  as restrictive for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

-- ── 5.5 CREAR estructura del piso (INSERT restrictive con sectores.gestionar)
drop policy if exists "piso_sectores_crear_restr" on public.piso_sectores;
create policy "piso_sectores_crear_restr" on public.piso_sectores
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_bloques_crear_restr" on public.piso_bloques;
create policy "piso_bloques_crear_restr" on public.piso_bloques
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_columnas_crear_restr" on public.piso_columnas;
create policy "piso_columnas_crear_restr" on public.piso_columnas
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_columna_bloques_crear_restr" on public.piso_columna_bloques;
create policy "piso_columna_bloques_crear_restr" on public.piso_columna_bloques
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_niveles_crear_restr" on public.piso_niveles;
create policy "piso_niveles_crear_restr" on public.piso_niveles
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_posiciones_crear_restr" on public.piso_posiciones;
create policy "piso_posiciones_crear_restr" on public.piso_posiciones
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

drop policy if exists "piso_subcolumnas_crear_restr" on public.piso_subcolumnas;
create policy "piso_subcolumnas_crear_restr" on public.piso_subcolumnas
  as restrictive for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'sectores.gestionar'));

-- ─────────────────────────────────────────────────────────────────────────
-- 6 · GUARDS EN 14 RPCs SECURITY DEFINER (escrituras que saltan RLS)
--    Generados por scripts/gen_guard_rpc.py desde pg_get_functiondef (vivos).
--    Respaldo de las definiciones originales:
--    scripts/respaldo_rpc_antes_guard_20261031.sql
--    Las llamadas anidadas (p. ej. transito→registrar_movimiento_kardex)
--    heredan la autorización de la RPC externa (GUC rackly.en_rpc_interna).
-- ─────────────────────────────────────────────────────────────────────────

-- ── RPC: registrar_movimiento_kardex → permiso movimientos.crear (plpgsql) ──
CREATE OR REPLACE FUNCTION public.registrar_movimiento_kardex(p_tipo text, p_bloque text, p_torre text, p_piso text, p_posicion text, p_codigo text, p_descripcion text, p_un text, p_cantidad numeric, p_f_vencimiento date, p_turno text, p_usuario_id uuid, p_usuario_nombre text, p_usuario_correo text, p_proveedor text, p_uuid_sync text DEFAULT NULL::text, p_codigo_inc text DEFAULT NULL::text, p_lote text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_stock NUMERIC;
  v_loc_key TEXT;
  v_codigo_clean TEXT;
  v_lote_final TEXT;
  v_saldo_sin_lote NUMERIC;
  v_saldo_lote_digit NUMERIC;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'movimientos.crear') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para registrar movimientos de racks';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  -- Normalizar codigo
  v_codigo_clean := UPPER(TRIM(p_codigo));

  -- v7 (auditoría 2026-10-21): la cantidad debe ser positiva. Antes una
  -- salida con cantidad negativa pasaba la validación de stock y SUMABA,
  -- y un ingreso negativo RESTABA — corrupción silenciosa del inventario.
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad debe ser mayor que cero';
  END IF;

  -- v8 (auditoría 2026-10-23): rechazar vencimientos con año absurdo.
  -- Typos reales en producción: 0202, 3027, 20828 — corrompen el FEFO
  -- (0202 "vence" siempre primero; 3027 nunca). Rango operativo: 2000–2100.
  IF p_f_vencimiento IS NOT NULL AND
     (EXTRACT(YEAR FROM p_f_vencimiento) < 2000
      OR EXTRACT(YEAR FROM p_f_vencimiento) > 2100) THEN
    RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', p_f_vencimiento;
  END IF;

  -- Advisory lock por ubicacion + codigo (se libera al terminar la transaccion)
  v_loc_key := p_bloque || '/' || p_torre || '/' || p_piso || '/' || p_posicion || '/' || v_codigo_clean;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_loc_key, 0));

  -- Stock actual normalizando ubicacion (fix '01' vs '1') y contando stock_inicial
  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
      WHEN tipo = 'salida' THEN -cantidad
      ELSE 0
    END
  ), 0) INTO v_current_stock
  FROM movimientos
  WHERE bloque = p_bloque
    AND TRIM(LEADING '0' FROM torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
    AND TRIM(LEADING '0' FROM piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
    AND TRIM(LEADING '0' FROM posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
    AND codigo = v_codigo_clean
    -- Excluir INC del stock para salidas normales (no INC)
    AND (p_tipo != 'salida' OR p_codigo_inc IS NOT NULL OR codigo_inc IS NULL);

  -- Validar: salidas no pueden exceder el stock disponible
  IF p_tipo = 'salida' AND p_codigo_inc IS NULL AND p_cantidad > v_current_stock THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK|Stock actual = % %, cantidad solicitada = %',
      v_current_stock, COALESCE(p_un, ''), p_cantidad;
  END IF;

  -- ═══ v4 · AUTO-LOTE FEFO para salidas normales sin lote ═══
  -- Si la salida llega sin lote físico, asignarle uno con saldo por lote
  -- suficiente: evita que el bucket lote='' acumule déficit artificial.
  v_lote_final := NULLIF(TRIM(p_lote), '');

  -- ═══ v6 · VALIDACIÓN del lote digitado en salidas normales ═══
  IF p_tipo = 'salida' AND p_codigo_inc IS NULL AND v_lote_final IS NOT NULL THEN
    SELECT COALESCE(SUM(
      CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad
           WHEN m.tipo = 'salida' THEN -m.cantidad ELSE 0 END), 0)
      INTO v_saldo_lote_digit
    FROM movimientos m
    WHERE m.bloque = p_bloque
      AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
      AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
      AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
      AND m.codigo = v_codigo_clean
      AND m.codigo_inc IS NULL
      AND NULLIF(TRIM(m.lote), '') = v_lote_final;
    IF COALESCE(v_saldo_lote_digit, 0) < p_cantidad THEN
      v_lote_final := NULL;  -- sin cobertura: decide el pipeline v4/v5
    END IF;
  END IF;
  IF p_tipo = 'salida' AND p_codigo_inc IS NULL AND v_lote_final IS NULL THEN
    -- 1) lote cuyo saldo por lote cubre TODA la cantidad (FEFO)
    SELECT c.lote INTO v_lote_final
    FROM (
      SELECT m.lote AS lote,
             SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad ELSE -m.cantidad END) AS saldo_lote,
             MIN(m.f_vencimiento) AS min_venc,
             MIN(m.f_modificacion) AS primer_ing
      FROM movimientos m
      WHERE m.bloque = p_bloque
        AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
        AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
        AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
        AND m.codigo = v_codigo_clean
        AND m.codigo_inc IS NULL
        AND NULLIF(TRIM(m.lote), '') IS NOT NULL
      GROUP BY m.lote
    ) c
    WHERE c.saldo_lote >= p_cantidad
    ORDER BY c.min_venc ASC NULLS LAST, c.primer_ing ASC
    LIMIT 1;
    -- 2) v5 · bucket "sin lote" absorbe la salida si tiene saldo suficiente
    IF v_lote_final IS NULL THEN
      SELECT COALESCE(SUM(
        CASE WHEN m2.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m2.cantidad
             WHEN m2.tipo = 'salida' THEN -m2.cantidad ELSE 0 END), 0)
        INTO v_saldo_sin_lote
      FROM movimientos m2
      WHERE m2.bloque = p_bloque
        AND TRIM(LEADING '0' FROM m2.torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
        AND TRIM(LEADING '0' FROM m2.piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
        AND TRIM(LEADING '0' FROM m2.posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
        AND m2.codigo = v_codigo_clean
        AND m2.codigo_inc IS NULL
        AND COALESCE(TRIM(m2.lote), '') = '';
    END IF;
    -- 3) último recurso: el lote físico de mayor saldo
    IF v_lote_final IS NULL AND COALESCE(v_saldo_sin_lote, 0) < p_cantidad THEN
      SELECT c.lote INTO v_lote_final
      FROM (
        SELECT m.lote AS lote,
               SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad ELSE -m.cantidad END) AS saldo_lote
        FROM movimientos m
        WHERE m.bloque = p_bloque
          AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
          AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
          AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
          AND m.codigo = v_codigo_clean
          AND m.codigo_inc IS NULL
          AND NULLIF(TRIM(m.lote), '') IS NOT NULL
        GROUP BY m.lote
      ) c
      WHERE c.saldo_lote > 0
      ORDER BY c.saldo_lote DESC
      LIMIT 1;
    END IF;
  END IF;

  -- Insertar el movimiento (lote = digitado o auto-asignado por FEFO; NULL si no hay)
  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, uuid_sync, codigo_inc, lote)
  VALUES (
    p_tipo, p_bloque, p_torre, p_piso, p_posicion, v_codigo_clean,
    p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_uuid_sync, p_codigo_inc,
    v_lote_final
  );

  RETURN jsonb_build_object(
    'success', true,
    'previous_stock', v_current_stock,
    'new_stock', v_current_stock + CASE
      WHEN p_tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN p_cantidad
      ELSE -p_cantidad
    END
  );
END;
$function$


-- ── RPC: registrar_traslado_kardex → permiso movimientos.crear (plpgsql) ──
CREATE OR REPLACE FUNCTION public.registrar_traslado_kardex(p_codigo text, p_descripcion text, p_un text, p_cantidad numeric, p_orig_bloque text, p_orig_torre text, p_orig_piso text, p_orig_pos text, p_dest_bloque text, p_dest_torre text, p_dest_piso text, p_dest_pos text, p_turno text, p_usuario_id uuid, p_usuario_nombre text, p_usuario_correo text, p_f_vencimiento date, p_proveedor text, p_cantidad_ajuste numeric DEFAULT 0, p_codigo_inc text DEFAULT NULL::text, p_uuid_sync text DEFAULT NULL::text, p_lote text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_orig_stock NUMERIC;
  v_codigo_clean TEXT;
  v_orig_key TEXT;
  v_dest_key TEXT;
  v_lote_final TEXT;
  v_saldo_sin_lote NUMERIC;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'movimientos.crear') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para registrar movimientos de racks';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  v_codigo_clean := UPPER(TRIM(p_codigo));

  -- v7 (auditoría 2026-10-21): la cantidad debe ser positiva
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad a trasladar debe ser mayor que cero';
  END IF;

  -- v8 (auditoría 2026-10-23): rechazar vencimientos con año absurdo.
  -- Typos reales en producción: 0202, 3027, 20828 — corrompen el FEFO
  -- (0202 "vence" siempre primero; 3027 nunca). Rango operativo: 2000–2100.
  IF p_f_vencimiento IS NOT NULL AND
     (EXTRACT(YEAR FROM p_f_vencimiento) < 2000
      OR EXTRACT(YEAR FROM p_f_vencimiento) > 2100) THEN
    RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', p_f_vencimiento;
  END IF;

  IF p_orig_bloque = p_dest_bloque AND p_orig_torre = p_dest_torre
     AND p_orig_piso = p_dest_piso AND p_orig_pos = p_dest_pos THEN
    RAISE EXCEPTION 'SAME_ORIGIN_DESTINATION|El destino no puede ser igual al origen';
  END IF;

  v_orig_key := p_orig_bloque || '/' || p_orig_torre || '/' || p_orig_piso || '/' || p_orig_pos || '/' || v_codigo_clean;
  v_dest_key := p_dest_bloque || '/' || p_dest_torre || '/' || p_dest_piso || '/' || p_dest_pos || '/' || v_codigo_clean;

  IF v_orig_key < v_dest_key THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_orig_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(v_dest_key, 0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(v_dest_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(v_orig_key, 0));
  END IF;

  -- Stock en origen normalizando ubicacion ('01' == '1') + contando stock_inicial
  -- + excluyendo INC para traslados normales
  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN cantidad
      WHEN tipo = 'salida' THEN -cantidad
      ELSE 0
    END
  ), 0) INTO v_orig_stock
  FROM movimientos
  WHERE bloque = p_orig_bloque
    AND TRIM(LEADING '0' FROM torre) = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
    AND TRIM(LEADING '0' FROM piso) = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
    AND TRIM(LEADING '0' FROM posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
    AND codigo = v_codigo_clean
    AND (p_codigo_inc IS NOT NULL OR codigo_inc IS NULL);

  -- v7 (auditoría 2026-10-21): el AJUSTE POSITIVO ingresa mercadería en origen
  -- ANTES de la salida (misma transacción, fila 'ingreso' más abajo), así que
  -- el disponible real es stock + ajuste. Antes se validaba solo contra el
  -- stock y el ajuste positivo era inalcanzable desde la UI (feature muerta).
  IF p_cantidad > v_orig_stock + COALESCE(p_cantidad_ajuste, 0) THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK_ORIGIN|Stock en origen = % %, cantidad a trasladar = % (ajuste = %)',
      v_orig_stock, COALESCE(p_un, ''), p_cantidad, COALESCE(p_cantidad_ajuste, 0);
  END IF;

  -- ═══ v4 · AUTO-LOTE FEFO para el traslado (salida en origen) ═══
  v_lote_final := NULLIF(TRIM(p_lote), '');
  IF p_codigo_inc IS NULL AND v_lote_final IS NULL THEN
    SELECT c.lote INTO v_lote_final
    FROM (
      SELECT m.lote AS lote,
             SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad ELSE -m.cantidad END) AS saldo_lote,
             MIN(m.f_vencimiento) AS min_venc,
             MIN(m.f_modificacion) AS primer_ing
      FROM movimientos m
      WHERE m.bloque = p_orig_bloque
        AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
        AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
        AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
        AND m.codigo = v_codigo_clean
        AND m.codigo_inc IS NULL
        AND NULLIF(TRIM(m.lote), '') IS NOT NULL
      GROUP BY m.lote
    ) c
    WHERE c.saldo_lote >= p_cantidad
    ORDER BY c.min_venc ASC NULLS LAST, c.primer_ing ASC
    LIMIT 1;
    -- 2) v5 · bucket "sin lote" del origen absorbe si tiene saldo suficiente
    IF v_lote_final IS NULL THEN
      SELECT COALESCE(SUM(
        CASE WHEN m2.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m2.cantidad
             WHEN m2.tipo = 'salida' THEN -m2.cantidad ELSE 0 END), 0)
        INTO v_saldo_sin_lote
      FROM movimientos m2
      WHERE m2.bloque = p_orig_bloque
        AND TRIM(LEADING '0' FROM m2.torre) = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
        AND TRIM(LEADING '0' FROM m2.piso) = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
        AND TRIM(LEADING '0' FROM m2.posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
        AND m2.codigo = v_codigo_clean
        AND m2.codigo_inc IS NULL
        AND COALESCE(TRIM(m2.lote), '') = '';
    END IF;
    -- 3) último recurso: el lote físico de mayor saldo
    IF v_lote_final IS NULL AND COALESCE(v_saldo_sin_lote, 0) < p_cantidad THEN
      SELECT c.lote INTO v_lote_final
      FROM (
        SELECT m.lote AS lote,
               SUM(CASE WHEN m.tipo IN ('ingreso','devolucion','traslado','stock_inicial') THEN m.cantidad ELSE -m.cantidad END) AS saldo_lote
        FROM movimientos m
        WHERE m.bloque = p_orig_bloque
          AND TRIM(LEADING '0' FROM m.torre) = TRIM(LEADING '0' FROM NULLIF(p_orig_torre, '0'))
          AND TRIM(LEADING '0' FROM m.piso) = TRIM(LEADING '0' FROM NULLIF(p_orig_piso, '0'))
          AND TRIM(LEADING '0' FROM m.posicion) = TRIM(LEADING '0' FROM NULLIF(p_orig_pos, '0'))
          AND m.codigo = v_codigo_clean
          AND m.codigo_inc IS NULL
          AND NULLIF(TRIM(m.lote), '') IS NOT NULL
        GROUP BY m.lote
      ) c
      WHERE c.saldo_lote > 0
      ORDER BY c.saldo_lote DESC
      LIMIT 1;
    END IF;
  END IF;

  -- ═══ FIX idx_movimientos_uuid_sync_unique ═══
  -- Solo la PRIMERA fila del traslado lleva uuid_sync (idempotencia)
  IF p_cantidad_ajuste IS NOT NULL AND p_cantidad_ajuste != 0 THEN
    INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
      cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync, lote)
    VALUES (
      CASE WHEN p_cantidad_ajuste > 0 THEN 'ingreso' ELSE 'salida' END,
      p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
      v_codigo_clean, p_descripcion, p_un,
      ABS(p_cantidad_ajuste),
      p_f_vencimiento, p_turno, p_usuario_id,
      p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc, p_uuid_sync,
      NULLIF(TRIM(p_lote), '')
    );
  END IF;

  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync, lote)
  VALUES (
    'salida', p_orig_bloque, p_orig_torre, p_orig_piso, p_orig_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc,
    CASE WHEN COALESCE(p_cantidad_ajuste, 0) != 0 THEN NULL ELSE p_uuid_sync END,
    v_lote_final
  );

  INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
    cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, codigo_inc, uuid_sync, lote)
  VALUES (
    'traslado', p_dest_bloque, p_dest_torre, p_dest_piso, p_dest_pos,
    v_codigo_clean, p_descripcion, p_un, p_cantidad,
    p_f_vencimiento, p_turno, p_usuario_id,
    p_usuario_nombre, p_usuario_correo, p_proveedor, p_codigo_inc,
    NULL,
    v_lote_final
  );

  RETURN jsonb_build_object(
    'success', true,
    'origin_previous_stock', v_orig_stock,
    'origin_new_stock', v_orig_stock - p_cantidad + COALESCE(p_cantidad_ajuste, 0)
  );
END;
$function$


-- ── RPC: editar_lote_vencimiento_racks → permiso lote.editar (plpgsql) ──
CREATE OR REPLACE FUNCTION public.editar_lote_vencimiento_racks(p_bloque text, p_torre text, p_piso text, p_posicion text, p_codigo text, p_lote text DEFAULT NULL::text, p_f_vencimiento text DEFAULT NULL::text, p_lote_actual text DEFAULT NULL::text, p_f_vencimiento_actual text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_codigo      TEXT;
  v_lote        TEXT;
  v_fven        DATE;
  v_lote_actual TEXT;
  v_fven_actual DATE;
  v_rows        INT;
  v_loc_key     TEXT;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'lote.editar') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para editar lote y vencimiento';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  v_codigo := UPPER(TRIM(p_codigo));
  v_lote   := NULLIF(TRIM(p_lote), '');
  v_lote_actual := NULLIF(TRIM(p_lote_actual), '');

  -- Fechas con mensaje claro si el formato no es AAAA-MM-DD
  IF p_f_vencimiento IS NOT NULL AND TRIM(p_f_vencimiento) <> '' THEN
    BEGIN
      v_fven := TRIM(p_f_vencimiento)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;
  IF p_f_vencimiento_actual IS NOT NULL AND TRIM(p_f_vencimiento_actual) <> '' THEN
    BEGIN
      v_fven_actual := TRIM(p_f_vencimiento_actual)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento actual inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;

  -- v8 (auditoría 2026-10-23): el NUEVO valor no puede tener año absurdo
  -- (0202/3027/…). El valor ACTUAL (v_fven_actual) NO se valida: existen filas
  -- históricas con año absurdo y deben poder corregirse.
  IF v_fven IS NOT NULL AND
     (EXTRACT(YEAR FROM v_fven) < 2000 OR EXTRACT(YEAR FROM v_fven) > 2100) THEN
    RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fven;
  END IF;

  IF v_codigo IS NULL OR v_codigo = '' THEN
    RAISE EXCEPTION 'SIN_DATOS|Código de artículo vacío';
  END IF;
  IF v_lote IS NULL AND v_fven IS NULL THEN
    RAISE EXCEPTION 'SIN_DATOS|Indique el lote y/o la fecha de vencimiento del producto';
  END IF;

  -- Anti-carrera: misma llave que registrar_movimiento_kardex (bloque/torre/
  -- piso/posicion/código) para que ninguna salida se intercale durante el cambio.
  v_loc_key := p_bloque || '/' || p_torre || '/' || p_piso || '/' || p_posicion || '/' || v_codigo;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_loc_key, 0));

  UPDATE movimientos
  SET lote = v_lote,
      f_vencimiento = v_fven
  WHERE bloque = p_bloque
    AND TRIM(LEADING '0' FROM torre)    = TRIM(LEADING '0' FROM NULLIF(p_torre, '0'))
    AND TRIM(LEADING '0' FROM piso)     = TRIM(LEADING '0' FROM NULLIF(p_piso, '0'))
    AND TRIM(LEADING '0' FROM posicion) = TRIM(LEADING '0' FROM NULLIF(p_posicion, '0'))
    AND codigo = v_codigo
    AND codigo_inc IS NULL
    -- Bucket EXACTO a editar (v1 = bucket vacío; v2 = cualquier bucket mostrado)
    AND COALESCE(TRIM(lote), '') = COALESCE(v_lote_actual, '')
    AND f_vencimiento IS NOT DISTINCT FROM v_fven_actual;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'SIN_FILAS|No hay stock con esos datos para % en esa ubicación (puede que ya se haya corregido)', v_codigo;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'filas_actualizadas', v_rows,
    'lote', v_lote,
    'f_vencimiento', v_fven
  );
END;
$function$


-- ── RPC: editar_lote_vencimiento_piso → permiso lote.editar (plpgsql) ──
CREATE OR REPLACE FUNCTION public.editar_lote_vencimiento_piso(p_posicion_id uuid, p_bloque_id uuid, p_lote text DEFAULT NULL::text, p_f_vencimiento text DEFAULT NULL::text, p_lote_actual text DEFAULT NULL::text, p_f_vencimiento_actual text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lote        TEXT;
  v_fven        DATE;
  v_lote_actual TEXT;
  v_fven_actual DATE;
  v_rows        INT;
  v_lock        TEXT;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'lote.editar') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para editar lote y vencimiento';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  v_lote        := NULLIF(TRIM(p_lote), '');
  v_lote_actual := NULLIF(TRIM(p_lote_actual), '');

  IF p_f_vencimiento IS NOT NULL AND TRIM(p_f_vencimiento) <> '' THEN
    BEGIN
      v_fven := TRIM(p_f_vencimiento)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;
  IF p_f_vencimiento_actual IS NOT NULL AND TRIM(p_f_vencimiento_actual) <> '' THEN
    BEGIN
      v_fven_actual := TRIM(p_f_vencimiento_actual)::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|Fecha de vencimiento actual inválida (formato esperado: AAAA-MM-DD)';
    END;
  END IF;

  IF v_lote IS NULL AND v_fven IS NULL THEN
    RAISE EXCEPTION 'SIN_DATOS|Indique el lote y/o la fecha de vencimiento del producto';
  END IF;

  -- v8 (auditoría 2026-10-23): el NUEVO valor no puede tener año absurdo
  -- (0202/3027/…). El valor ACTUAL (v_fven_actual) NO se valida: existen filas
  -- históricas con año absurdo y deben poder corregirse.
  IF v_fven IS NOT NULL AND
     (EXTRACT(YEAR FROM v_fven) < 2000 OR EXTRACT(YEAR FROM v_fven) > 2100) THEN
    RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fven;
  END IF;

  -- Anti-carrera por posición+artículo
  v_lock := p_posicion_id::text || '/' || p_bloque_id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lock, 0));

  UPDATE piso_movimiento_detalles d
  SET lote = v_lote,
      fecha_vencimiento = v_fven
  FROM piso_niveles n
  WHERE d.nivel_id = n.id
    AND n.posicion_id = p_posicion_id
    AND d.bloque_id = p_bloque_id
    -- Bucket EXACTO a editar (v1 = bucket vacío; v2 = cualquier bucket mostrado)
    AND COALESCE(TRIM(d.lote), '') = COALESCE(v_lote_actual, '')
    AND d.fecha_vencimiento IS NOT DISTINCT FROM v_fven_actual;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'SIN_FILAS|No hay stock con esos datos para este artículo en esa posición (puede que ya se haya corregido)';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'filas_actualizadas', v_rows,
    'lote', v_lote,
    'f_vencimiento', v_fven
  );
END;
$function$


-- ── RPC: piso_registrar_salida → permiso piso_movimientos.crear (plpgsql) ──
CREATE OR REPLACE FUNCTION public.piso_registrar_salida(_turno text, _usuario_id uuid, _usuario_nombre text, _usuario_correo text, _uuid_sync text DEFAULT NULL::text, _detalles jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE
  v_mov_id   UUID;
  v_det      JSONB;
  v_nivel_id UUID;
  v_bloque_id UUID;
  v_qty      NUMERIC;
  v_current  NUMERIC;
  v_fecha    DATE;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'piso_movimientos.crear') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para registrar movimientos de piso';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  FOR v_nivel_id IN
    SELECT DISTINCT (d->>'nivel_id')::UUID
    FROM jsonb_array_elements(_detalles) AS d
    ORDER BY (d->>'nivel_id')::TEXT
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_nivel_id::TEXT, 0));
  END LOOP;

  FOR v_nivel_id, v_bloque_id, v_qty IN
    SELECT
      (d->>'nivel_id')::UUID,
      (d->>'bloque_id')::UUID,
      COALESCE(SUM((d->>'cantidad')::NUMERIC), 0)
    FROM jsonb_array_elements(_detalles) AS d
    GROUP BY (d->>'nivel_id')::UUID, (d->>'bloque_id')::UUID
  LOOP
    SELECT COALESCE(SUM(
      CASE
        WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion') THEN dd.cantidad
        WHEN m.tipo = 'salida' THEN -dd.cantidad
        ELSE 0
      END
    ), 0) INTO v_current
    FROM public.piso_movimiento_detalles dd
    JOIN public.piso_movimientos m ON m.id = dd.movimiento_id
    WHERE dd.nivel_id = v_nivel_id
      AND dd.bloque_id = v_bloque_id
      AND m.codigo_inc IS NULL;

    IF v_qty > v_current THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK|Stock actual = %, cantidad solicitada = %',
        v_current, v_qty;
    END IF;
  END LOOP;

  INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('salida', _turno, _usuario_id, _usuario_nombre, _usuario_correo, _uuid_sync)
  RETURNING id INTO v_mov_id;

  FOR v_det IN SELECT * FROM jsonb_array_elements(_detalles)
  LOOP
    BEGIN
      v_fecha := NULL;
      IF v_det->>'fecha_vencimiento' IS NOT NULL
         AND (v_det->>'fecha_vencimiento') != ''
         AND (v_det->>'fecha_vencimiento') != 'null' THEN
        v_fecha := to_date(v_det->>'fecha_vencimiento', 'YYYY-MM-DD');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        v_fecha := (v_det->>'fecha_vencimiento')::TIMESTAMPTZ::DATE;
      EXCEPTION WHEN OTHERS THEN
        v_fecha := NULL;
      END;
    END;

    -- v8 (auditoría 2026-10-23): año absurdo corrompe el FEFO (2000–2100).
    IF v_fecha IS NOT NULL AND
       (EXTRACT(YEAR FROM v_fecha) < 2000 OR EXTRACT(YEAR FROM v_fecha) > 2100) THEN
      RAISE EXCEPTION 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fecha;
    END IF;

    INSERT INTO public.piso_movimiento_detalles (
      movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento
    ) VALUES (
      v_mov_id,
      (v_det->>'nivel_id')::UUID,
      (v_det->>'bloque_id')::UUID,
      COALESCE((v_det->>'cantidad')::NUMERIC, 0),
      v_fecha
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'movimiento_id', v_mov_id);
END;
 $function$


-- ── RPC: piso_registrar_traslado → permiso piso_movimientos.crear (plpgsql) ──
CREATE OR REPLACE FUNCTION public.piso_registrar_traslado(_turno text, _usuario_id uuid, _usuario_nombre text, _usuario_correo text, _uuid_sync text DEFAULT NULL::text, _detalles_salida jsonb DEFAULT '[]'::jsonb, _detalles_ingreso jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE
  v_sal_id   UUID;
  v_ing_id   UUID;
  v_det      JSONB;
  v_nivel_id UUID;
  v_bloque_id UUID;
  v_qty      NUMERIC;
  v_current  NUMERIC;
  v_fecha    DATE;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'piso_movimientos.crear') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para registrar movimientos de piso';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  FOR v_nivel_id IN
    SELECT DISTINCT nid FROM (
      SELECT (d->>'nivel_id')::UUID AS nid FROM jsonb_array_elements(_detalles_salida) AS d
      UNION
      SELECT (d->>'nivel_id')::UUID AS nid FROM jsonb_array_elements(_detalles_ingreso) AS d
    ) sub ORDER BY nid::TEXT
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_nivel_id::TEXT, 0));
  END LOOP;

  FOR v_nivel_id, v_bloque_id, v_qty IN
    SELECT
      (d->>'nivel_id')::UUID,
      (d->>'bloque_id')::UUID,
      COALESCE(SUM((d->>'cantidad')::NUMERIC), 0)
    FROM jsonb_array_elements(_detalles_salida) AS d
    GROUP BY (d->>'nivel_id')::UUID, (d->>'bloque_id')::UUID
  LOOP
    SELECT COALESCE(SUM(
      CASE
        WHEN m.tipo IN ('ingreso', 'stock_inicial', 'devolucion') THEN dd.cantidad
        WHEN m.tipo = 'salida' THEN -dd.cantidad
        ELSE 0
      END
    ), 0) INTO v_current
    FROM public.piso_movimiento_detalles dd
    JOIN public.piso_movimientos m ON m.id = dd.movimiento_id
    WHERE dd.nivel_id = v_nivel_id
      AND dd.bloque_id = v_bloque_id
      AND m.codigo_inc IS NULL;

    IF v_qty > v_current THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK_ORIGIN|Stock en origen = %, cantidad solicitada = %',
        v_current, v_qty;
    END IF;
  END LOOP;

  INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('salida', _turno, _usuario_id, _usuario_nombre, _usuario_correo, _uuid_sync)
  RETURNING id INTO v_sal_id;

  INSERT INTO public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync)
  VALUES ('ingreso', _turno, _usuario_id, _usuario_nombre, _usuario_correo, _uuid_sync)
  RETURNING id INTO v_ing_id;

  FOR v_det IN SELECT * FROM jsonb_array_elements(_detalles_salida)
  LOOP
    BEGIN
      v_fecha := NULL;
      IF v_det->>'fecha_vencimiento' IS NOT NULL
         AND (v_det->>'fecha_vencimiento') != ''
         AND (v_det->>'fecha_vencimiento') != 'null' THEN
        v_fecha := to_date(v_det->>'fecha_vencimiento', 'YYYY-MM-DD');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        v_fecha := (v_det->>'fecha_vencimiento')::TIMESTAMPTZ::DATE;
      EXCEPTION WHEN OTHERS THEN
        v_fecha := NULL;
      END;
    END;

    INSERT INTO public.piso_movimiento_detalles (
      movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento
    ) VALUES (
      v_sal_id,
      (v_det->>'nivel_id')::UUID,
      (v_det->>'bloque_id')::UUID,
      COALESCE((v_det->>'cantidad')::NUMERIC, 0),
      v_fecha
    );
  END LOOP;

  FOR v_det IN SELECT * FROM jsonb_array_elements(_detalles_ingreso)
  LOOP
    BEGIN
      v_fecha := NULL;
      IF v_det->>'fecha_vencimiento' IS NOT NULL
         AND (v_det->>'fecha_vencimiento') != ''
         AND (v_det->>'fecha_vencimiento') != 'null' THEN
        v_fecha := to_date(v_det->>'fecha_vencimiento', 'YYYY-MM-DD');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        v_fecha := (v_det->>'fecha_vencimiento')::TIMESTAMPTZ::DATE;
      EXCEPTION WHEN OTHERS THEN
        v_fecha := NULL;
      END;
    END;

    INSERT INTO public.piso_movimiento_detalles (
      movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento
    ) VALUES (
      v_ing_id,
      (v_det->>'nivel_id')::UUID,
      (v_det->>'bloque_id')::UUID,
      COALESCE((v_det->>'cantidad')::NUMERIC, 0),
      v_fecha
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'salida_id', v_sal_id,
    'ingreso_id', v_ing_id
  );
END;
 $function$


-- ── RPC: piso_auto_estructura_sector → permiso sectores.gestionar (plpgsql) ──
CREATE OR REPLACE FUNCTION public.piso_auto_estructura_sector()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE
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
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'sectores.gestionar') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para gestionar la estructura del piso';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  FOR v_col_idx IN 1..NEW.n_columnas LOOP
    v_letra := CHR(64 + v_col_idx);
    INSERT INTO public.piso_columnas (letra, sector_id)
    VALUES (v_letra, NEW.id) RETURNING id INTO v_col_id;

    FOR v_sub_idx IN 1..NEW.n_subcolumnas LOOP
      v_sub_codigo := NEW.prefijo || v_letra || v_sub_idx;
      INSERT INTO public.piso_subcolumnas (codigo, columna_id)
      VALUES (v_sub_codigo, v_col_id) RETURNING id INTO v_sub_id;

      FOR v_pos_idx IN 1..NEW.n_posiciones LOOP
        INSERT INTO public.piso_posiciones (numero, subcolumna_id)
        VALUES (v_pos_idx, v_sub_id) RETURNING id INTO v_pos_id;

        FOR v_niv_idx IN 1..NEW.n_niveles LOOP
          INSERT INTO public.piso_niveles (numero, posicion_id, codigo_ubicacion)
          VALUES (v_niv_idx, v_pos_id, v_sub_codigo || '-' || v_pos_idx || '-' || v_niv_idx);
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN NEW;
END;
 $function$


-- ── RPC: rq_crear_completa → permiso atencion.crear (plpgsql) ──
CREATE OR REPLACE FUNCTION public.rq_crear_completa(p_rq jsonb, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id      uuid;
  v_item    jsonb;
  v_turno_rq text;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'atencion.crear') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para crear solicitudes (RQ)';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  v_id := (p_rq->>'id')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'ID_REQUERIDO|la RQ debe traer id preasignado (idempotencia)';
  END IF;

  -- Task 35: turno de la hoja física (004=T1, 005=T2). Vacío = no indicado.
  v_turno_rq := nullif(btrim(coalesce(p_rq->>'turno_rq', '')), '');
  IF v_turno_rq IS NOT NULL AND v_turno_rq NOT IN ('T1', 'T2') THEN
    RAISE EXCEPTION 'TURNO_RQ_INVALIDO|El turno del RQ debe ser T1 o T2 (recibido: "%")', v_turno_rq;
  END IF;

  INSERT INTO rq_atenciones (
    id, fecha, numero_rq, orden_produccion, producto_codigo,
    producto_descripcion, turno, turno_rq, linea, solicitante, estado,
    foto_url, notas, usuario_id, usuario_nombre, usuario_correo
  ) VALUES (
    v_id,
    coalesce((p_rq->>'fecha')::date, CURRENT_DATE),
    coalesce(p_rq->>'numero_rq', ''),
    coalesce(p_rq->>'orden_produccion', ''),
    coalesce(p_rq->>'producto_codigo', ''),
    coalesce(p_rq->>'producto_descripcion', ''),
    coalesce(p_rq->>'turno', 'T1'),
    v_turno_rq,
    coalesce(p_rq->>'linea', ''),
    coalesce(p_rq->>'solicitante', ''),
    'Pendiente',
    coalesce(p_rq->>'foto_url', ''),
    coalesce(p_rq->>'notas', ''),
    coalesce(NULLIF(btrim(coalesce(p_rq->>'usuario_id','')), '')::uuid,
             '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(p_rq->>'usuario_nombre', ''),
    coalesce(p_rq->>'usuario_correo', '')
  )
  ON CONFLICT (id) DO NOTHING;

  -- Materiales: inserta SOLO los que faltan (idempotente ante reintento).
  -- Llave natural de reenvío: (rq_id, orden, codigo) — el orden es la
  -- posición de la fila y no puede repetirse dentro de la misma RQ.
  FOR v_item IN
    SELECT * FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
    )
  LOOP
    INSERT INTO rq_atencion_items (
      rq_id, orden, codigo, descripcion, unidad, cantidad, cantidad_atendida
    )
    SELECT
      v_id,
      coalesce((v_item->>'orden')::int, 0),
      coalesce(v_item->>'codigo', ''),
      coalesce(v_item->>'descripcion', ''),
      coalesce(v_item->>'unidad', ''),
      coalesce((v_item->>'cantidad')::numeric, 0),
      0
    WHERE NOT EXISTS (
      SELECT 1 FROM rq_atencion_items x
      WHERE x.rq_id  = v_id
        AND x.orden  = coalesce((v_item->>'orden')::int, 0)
        AND x.codigo = coalesce(v_item->>'codigo', '')
    );
  END LOOP;

  RETURN v_id;
END;
$function$


-- ── RPC: rq_atender_lote → permiso atencion.crear (plpgsql) ──
CREATE OR REPLACE FUNCTION public.rq_atender_lote(p_item_id uuid, p_batch_uuid text, p_tomas jsonb, p_confirma_excedente boolean DEFAULT false, p_turno text DEFAULT ''::text, p_usuario_id uuid DEFAULT NULL::uuid, p_usuario_nombre text DEFAULT ''::text, p_usuario_correo text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item rq_atencion_items%ROWTYPE;
  v_rq rq_atenciones%ROWTYPE;
  v_toma jsonb;
  v_toma_uuid text;
  v_toma_actual text;
  v_ruta text;
  v_cant numeric;
  v_total numeric := 0;
  v_pendiente_rq numeric;
  v_recepcion_ids uuid[];
  v_rid uuid;
  v_row recepcion_registros%ROWTYPE;
  v_envios jsonb;
  v_enviados numeric;
  v_pendiente_fila numeric;
  v_codigo_item text;
  v_detalle jsonb := '[]'::jsonb;
  v_envio jsonb;
  v_res jsonb;
  v_bloque_piso_id uuid;
  v_nuevo numeric;
  v_pendientes integer;
  v_estado_rq text;
  v_sqlstate text;
  v_sqlerrm text;
  v_pipe integer;
  v_code text;
  v_msg text;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'atencion.crear') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para atender solicitudes';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  -- Guard de autorización (misma política que transito_registrar_envio).
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar atenciones por lote';
  END IF;

  IF p_batch_uuid IS NULL OR TRIM(p_batch_uuid) = '' THEN
    RAISE EXCEPTION 'LOTE_INVALIDO|Falta el identificador único del lote';
  END IF;
  IF p_tomas IS NULL OR jsonb_typeof(p_tomas) <> 'array' OR jsonb_array_length(p_tomas) = 0 THEN
    RAISE EXCEPTION 'LOTE_VACIO|El lote no tiene tomas';
  END IF;

  -- Forma de cada toma: falla ruidosamente ANTES de bloquear nada.
  FOR v_toma IN SELECT * FROM jsonb_array_elements(p_tomas) LOOP
    v_toma_uuid := COALESCE(v_toma->>'uuid', '');
    v_ruta := COALESCE(v_toma->>'ruta', '');
    v_cant := COALESCE((v_toma->>'cantidad')::numeric, 0);
    IF TRIM(v_toma_uuid) = '' THEN
      RAISE EXCEPTION 'TOMA_INVALIDA|Hay tomas sin uuid';
    END IF;
    IF v_ruta NOT IN ('transito', 'posicion') THEN
      RAISE EXCEPTION 'TOMA_INVALIDA|Toma % con ruta inválida (%)', v_toma_uuid, v_ruta;
    END IF;
    IF v_cant <= 0 THEN
      RAISE EXCEPTION 'TOMA_INVALIDA|Toma % con cantidad inválida', v_toma_uuid;
    END IF;
    IF (v_toma->>'recepcion_id') IS NULL OR TRIM(v_toma->>'recepcion_id') = '' THEN
      RAISE EXCEPTION 'TOMA_INVALIDA|Toma % sin recepcion_id', v_toma_uuid;
    END IF;
    IF v_ruta = 'posicion'
       AND (v_toma->'rack' IS NULL OR COALESCE(v_toma->'rack'->>'bloque','') = '')
       AND (v_toma->'piso' IS NULL OR COALESCE(v_toma->'piso'->>'nivel_id','') = '') THEN
      RAISE EXCEPTION 'UBICACION_REQUERIDA|Toma % sin ubicación de posición', v_toma_uuid;
    END IF;
  END LOOP;

  -- Ítem de la RQ (bloqueado hasta el fin de la transacción).
  SELECT * INTO v_item FROM rq_atencion_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NO_EXISTE|El material de la RQ ya no existe';
  END IF;
  SELECT * INTO v_rq FROM rq_atenciones WHERE id = v_item.rq_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RQ_NO_EXISTE|La RQ del material ya no existe';
  END IF;
  v_codigo_item := UPPER(TRIM(v_item.codigo));

  BEGIN
    -- ═══ Bloque transaccional: cualquier fallo revoca TODO ═══

    -- Dedupe dentro del lote: la misma paleta (fila) dos veces = rechazo.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_tomas) AS t
      GROUP BY t->>'recepcion_id' HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'PALETA_DUPLICADA|El lote intenta atender dos veces la misma paleta/fila';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_tomas) AS t
      GROUP BY t->>'uuid' HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'TOMA_DUPLICADA|El lote repite el uuid de una toma';
    END IF;

    -- Excedente sin confirmar (la RQ permite sobreatención, pero explícita).
    SELECT COALESCE(SUM((t->>'cantidad')::numeric), 0) INTO v_total
      FROM jsonb_array_elements(p_tomas) AS t;
    v_pendiente_rq := GREATEST(v_item.cantidad - v_item.cantidad_atendida, 0);
    IF v_total > v_pendiente_rq AND NOT COALESCE(p_confirma_excedente, false) THEN
      RAISE EXCEPTION 'EXCEDENTE_SIN_CONFIRMAR|El lote atiende % pero el pendiente es %: confirma el excedente para continuar',
        v_total, v_pendiente_rq;
    END IF;

    -- Locks de recepción EN ORDEN (anti-deadlock) — MISMA clave que Tránsito.
    SELECT array_agg(DISTINCT (t->>'recepcion_id')::uuid ORDER BY (t->>'recepcion_id')::uuid)
      INTO v_recepcion_ids
      FROM jsonb_array_elements(p_tomas) AS t;
    FOREACH v_rid IN ARRAY v_recepcion_ids LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_rid::text, 7771));
    END LOOP;

    -- IDEMPOTENCIA del lote: si cualquier fila afectada ya trae este batch,
    -- el lote YA se registró → éxito sin tocar nada (reintento seguro).
    FOREACH v_rid IN ARRAY v_recepcion_ids LOOP
      SELECT transito -> 'envios' INTO v_envios FROM recepcion_registros WHERE id = v_rid;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_envios, '[]'::jsonb)) AS e
        WHERE e->>'lote' = TRIM(p_batch_uuid)
      ) THEN
        RETURN jsonb_build_object('ok', true, 'duplicado', true, 'total_atendido', 0);
      END IF;
    END LOOP;

    -- ── Tomas ruta TRÁNSITO: descuento de la guía ──
    FOR v_toma IN SELECT value FROM jsonb_array_elements(p_tomas) WHERE value->>'ruta' = 'transito' LOOP
      v_toma_uuid := v_toma->>'uuid';
      v_toma_actual := v_toma_uuid;
      v_cant := (v_toma->>'cantidad')::numeric;

      SELECT * INTO v_row FROM recepcion_registros WHERE id = (v_toma->>'recepcion_id')::uuid;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECEPCION_NO_EXISTE|Toma %: la fila de recepción ya no existe', v_toma_uuid;
      END IF;
      IF UPPER(TRIM(v_row.codigo)) <> v_codigo_item THEN
        RAISE EXCEPTION 'CODIGO_AJENO|Toma %: el código de la guía (%) no corresponde al material de la RQ (%)',
          v_toma_uuid, v_row.codigo, v_item.codigo;
      END IF;

      v_envios := COALESCE(v_row.transito -> 'envios', '[]'::jsonb);
      SELECT COALESCE(SUM((e->>'cantidad')::numeric), 0) INTO v_enviados
        FROM jsonb_array_elements(v_envios) AS e;
      v_pendiente_fila := v_row.cantidad - v_enviados;
      IF v_cant > v_pendiente_fila THEN
        RAISE EXCEPTION 'OVER_ISSUE_TRANSITO|Toma %: pide % pero la guía solo tiene % en tránsito',
          v_toma_uuid, v_cant, v_pendiente_fila;
      END IF;

      v_envio := jsonb_build_object(
        'uuid', v_toma_uuid,
        'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
        'destino', 'atencion',
        'ubicacion', '',
        'cantidad', v_cant,
        'usuario_id', p_usuario_id,
        'usuario_nombre', p_usuario_nombre,
        'turno', p_turno,
        'rack', NULL,
        'piso', NULL,
        'rq', v_rq.numero_rq,
        'item_id', p_item_id,
        'lote', TRIM(p_batch_uuid)
      );
      UPDATE recepcion_registros
        SET transito = jsonb_build_object('v', 1, 'envios', (v_envios || jsonb_build_array(v_envio)))
        WHERE id = v_row.id;

      -- v3 (Task 27): la toma queda en el ledger.
      INSERT INTO rq_atencion_tomas
        (rq_id, item_id, codigo, origen, cantidad, ubicacion, lote, usuario_id, usuario_nombre, usuario_correo, turno)
      VALUES
        (v_item.rq_id, p_item_id, v_codigo_item, 'transito', v_cant, '', TRIM(p_batch_uuid),
         p_usuario_id, p_usuario_nombre, p_usuario_correo, p_turno);

      v_detalle := v_detalle || jsonb_build_array(jsonb_build_object(
        'uuid', v_toma_uuid, 'recepcion_id', v_row.id, 'ruta', 'transito',
        'cantidad', v_cant, 'nuevo_pendiente', v_pendiente_fila - v_cant
      ));
    END LOOP;

    -- ── Tomas ruta POSICIÓN: salida real de la ubicación ──
    FOR v_toma IN SELECT value FROM jsonb_array_elements(p_tomas) WHERE value->>'ruta' = 'posicion' LOOP
      v_toma_uuid := v_toma->>'uuid';
      v_toma_actual := v_toma_uuid;
      v_cant := (v_toma->>'cantidad')::numeric;

      SELECT * INTO v_row FROM recepcion_registros WHERE id = (v_toma->>'recepcion_id')::uuid;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECEPCION_NO_EXISTE|Toma %: la fila de recepción ya no existe', v_toma_uuid;
      END IF;
      IF UPPER(TRIM(v_row.codigo)) <> v_codigo_item THEN
        RAISE EXCEPTION 'CODIGO_AJENO|Toma %: el código de la guía (%) no corresponde al material de la RQ (%)',
          v_toma_uuid, v_row.codigo, v_item.codigo;
      END IF;

      IF v_toma->'rack' IS NOT NULL AND COALESCE(v_toma->'rack'->>'bloque', '') <> '' THEN
        -- Salida NATIVA de Racks (valida saldo INSUFFICIENT_STOCK + FEFO + lock propio).
        v_res := public.registrar_movimiento_kardex(
          'salida',
          v_toma->'rack'->>'bloque', v_toma->'rack'->>'torre', v_toma->'rack'->>'piso', v_toma->'rack'->>'posicion',
          v_codigo_item, v_row.descripcion, v_row.unidad_medida, v_cant,
          v_row.fecha_vencimiento, p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo,
          v_row.proveedor, v_toma_uuid, NULL, NULLIF(TRIM(COALESCE(v_row.lote, '')), '')
        );
        v_envio := jsonb_build_object(
          'uuid', v_toma_uuid,
          'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
          'destino', 'atencion_posicion',
          'ubicacion', COALESCE(v_toma->>'ubicacion', ''),
          'cantidad', 0,
          'cantidad_atencion', v_cant,
          'usuario_id', p_usuario_id,
          'usuario_nombre', p_usuario_nombre,
          'turno', p_turno,
          'rack', v_toma->'rack',
          'piso', NULL,
          'rq', v_rq.numero_rq,
          'item_id', p_item_id,
          'lote', TRIM(p_batch_uuid),
          'saldo_resultante', COALESCE(v_res->>'new_stock', '')
        );
        -- v3 (Task 27): la toma queda en el ledger CON el saldo resultante.
        INSERT INTO rq_atencion_tomas
          (rq_id, item_id, codigo, origen, cantidad, ubicacion, saldo_resultante, rack, lote, usuario_id, usuario_nombre, usuario_correo, turno)
        VALUES
          (v_item.rq_id, p_item_id, v_codigo_item, 'racks', v_cant,
           rq_ubicacion_texto(v_toma->'rack', NULL, v_toma->>'ubicacion'),
           NULLIF(COALESCE(v_res->>'new_stock', ''), '')::numeric,
           v_toma->'rack', TRIM(p_batch_uuid), p_usuario_id, p_usuario_nombre, p_usuario_correo, p_turno);
      ELSIF v_toma->'piso' IS NOT NULL AND COALESCE(v_toma->'piso'->>'nivel_id', '') <> '' THEN
        SELECT id INTO v_bloque_piso_id FROM piso_bloques WHERE codigo = v_codigo_item;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'BLOQUE_PISO_NO_EXISTE|Toma %: no existe bloque Piso para el código %', v_toma_uuid, v_item.codigo;
        END IF;
        -- Salida NATIVA de Piso (valida stock por nivel + locks propios).
        v_res := public.piso_registrar_salida(
          p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo, v_toma_uuid,
          jsonb_build_array(jsonb_build_object(
            'nivel_id', v_toma->'piso'->>'nivel_id',
            'bloque_id', v_bloque_piso_id,
            'cantidad', v_cant,
            'fecha_vencimiento', COALESCE(to_char(v_row.fecha_vencimiento, 'YYYY-MM-DD'), '')
          ))
        );
        v_envio := jsonb_build_object(
          'uuid', v_toma_uuid,
          'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
          'destino', 'atencion_posicion',
          'ubicacion', COALESCE(v_toma->>'ubicacion', ''),
          'cantidad', 0,
          'cantidad_atencion', v_cant,
          'usuario_id', p_usuario_id,
          'usuario_nombre', p_usuario_nombre,
          'turno', p_turno,
          'rack', NULL,
          'piso', v_toma->'piso',
          'rq', v_rq.numero_rq,
          'item_id', p_item_id,
          'lote', TRIM(p_batch_uuid)
        );
        -- v3 (Task 27): la toma queda en el ledger (Piso no reporta saldo).
        INSERT INTO rq_atencion_tomas
          (rq_id, item_id, codigo, origen, cantidad, ubicacion, piso, lote, usuario_id, usuario_nombre, usuario_correo, turno)
        VALUES
          (v_item.rq_id, p_item_id, v_codigo_item, 'piso', v_cant,
           rq_ubicacion_texto(NULL, v_toma->'piso', v_toma->>'ubicacion'),
           v_toma->'piso', TRIM(p_batch_uuid), p_usuario_id, p_usuario_nombre, p_usuario_correo, p_turno);
      ELSE
        RAISE EXCEPTION 'UBICACION_REQUERIDA|Toma % sin ubicación de posición', v_toma_uuid;
      END IF;

      UPDATE recepcion_registros
        SET transito = jsonb_build_object(
              'v', 1,
              'envios', (COALESCE(transito->'envios', '[]'::jsonb) || jsonb_build_array(v_envio)))
        WHERE id = v_row.id;

      v_detalle := v_detalle || jsonb_build_array(jsonb_build_object(
        'uuid', v_toma_uuid, 'recepcion_id', v_row.id, 'ruta', 'posicion',
        'cantidad', v_cant
      ));
    END LOOP;

    -- ── Ítem RQ: UNA sola actualización + estado del encabezado ──
    v_nuevo := v_item.cantidad_atendida + v_total;
    UPDATE rq_atencion_items SET
      cantidad_atendida = v_nuevo,
      usuario_atencion = COALESCE(NULLIF(p_usuario_nombre, ''), v_item.usuario_atencion),
      atendido_en = CASE WHEN v_nuevo >= v_item.cantidad THEN now() ELSE NULL END
    WHERE id = p_item_id;

    SELECT COUNT(*) INTO v_pendientes
      FROM rq_atencion_items
      WHERE rq_id = v_item.rq_id AND cantidad_atendida < cantidad;
    v_estado_rq := CASE WHEN v_pendientes = 0 THEN 'Atendido' ELSE 'En proceso' END;
    UPDATE rq_atenciones SET estado = v_estado_rq WHERE id = v_item.rq_id;

    RETURN jsonb_build_object(
      'ok', true,
      'duplicado', false,
      'total_atendido', v_total,
      'tomas_ok', jsonb_array_length(v_detalle),
      'nuevo_atendido', v_nuevo,
      'pendiente_rq', GREATEST(v_item.cantidad - v_nuevo, 0),
      'estado_rq', v_estado_rq,
      'detalle', v_detalle
    );

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_sqlerrm = MESSAGE_TEXT;
    v_pipe := position('|' in v_sqlerrm);
    IF v_pipe > 1 THEN
      v_code := substring(v_sqlerrm from 1 for v_pipe - 1);
      v_msg := substring(v_sqlerrm from v_pipe + 1);
    ELSE
      v_code := v_sqlstate;
      v_msg := v_sqlerrm;
    END IF;
    RETURN jsonb_build_object('ok', false, 'fallo', jsonb_build_object(
      'codigo', v_code,
      'mensaje', v_msg,
      'toma', v_toma_actual
    ));
  END;
END;
$function$


-- ── RPC: rq_revertir_origen → permiso atencion.editar (plpgsql) ──
CREATE OR REPLACE FUNCTION public.rq_revertir_origen(p_item_id uuid, p_batch_uuid text DEFAULT NULL::text, p_turno text DEFAULT ''::text, p_usuario_id uuid DEFAULT NULL::uuid, p_usuario_nombre text DEFAULT ''::text, p_usuario_correo text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item rq_atencion_items%ROWTYPE;
  v_rq rq_atenciones%ROWTYPE;
  v_codigo_item text;
  v_fila record;
  v_envio jsonb;
  v_toma_uuid text;
  v_toma_actual text;
  v_reversa_de text;
  v_ruta text;
  v_cant numeric;
  v_total_revertido numeric := 0;
  v_tomas_revertidas integer := 0;
  v_envios jsonb;
  v_nuevo_envio jsonb;
  v_uuid_reversa text;
  v_lote_reversa text;
  v_bloque_piso_id uuid;
  v_mov_id uuid;
  v_rid uuid;
  v_ids_recepcion uuid[];
  v_nuevo numeric;
  v_pendientes integer;
  v_total_items integer;
  v_estado_rq text;
  v_res jsonb;
  v_sqlstate text;
  v_sqlerrm text;
  v_pipe integer;
  v_code text;
  v_msg text;
  v_candidatas integer := 0;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'atencion.editar') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para revertir atenciones';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden revertir atenciones con origen';
  END IF;

  SELECT * INTO v_item FROM rq_atencion_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NO_EXISTE|El material de la RQ ya no existe';
  END IF;
  SELECT * INTO v_rq FROM rq_atenciones WHERE id = v_item.rq_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RQ_NO_EXISTE|La RQ del material ya no existe';
  END IF;
  v_codigo_item := UPPER(TRIM(v_item.codigo));

  BEGIN
    -- Filas afectadas: las guías del código cuyo jsonb trae tomas de ESTE item
    -- (y del batch pedido, si viene) usando contención jsonb del arreglo.
    IF p_batch_uuid IS NOT NULL AND TRIM(p_batch_uuid) <> '' THEN
      SELECT array_agg(DISTINCT r.id ORDER BY r.id) INTO v_ids_recepcion
        FROM recepcion_registros r
        WHERE UPPER(TRIM(r.codigo)) = v_codigo_item
          AND r.transito->'envios' @> jsonb_build_array(
                jsonb_build_object('lote', TRIM(p_batch_uuid), 'item_id', p_item_id));
    ELSE
      SELECT array_agg(DISTINCT r.id ORDER BY r.id) INTO v_ids_recepcion
        FROM recepcion_registros r
        WHERE UPPER(TRIM(r.codigo)) = v_codigo_item
          AND r.transito->'envios' @> jsonb_build_array(jsonb_build_object('item_id', p_item_id));
    END IF;

    IF v_ids_recepcion IS NULL OR array_length(v_ids_recepcion, 1) IS NULL THEN
      RAISE EXCEPTION 'LOTE_NO_ENCONTRADO|No hay atenciones del puente registradas para este material';
    END IF;

    FOREACH v_rid IN ARRAY v_ids_recepcion LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_rid::text, 7771));
    END LOOP;

    FOREACH v_rid IN ARRAY v_ids_recepcion LOOP
      SELECT * INTO v_fila FROM recepcion_registros WHERE id = v_rid;
      SELECT transito->'envios' INTO v_envios FROM recepcion_registros WHERE id = v_rid;

      FOR v_envio IN SELECT value FROM jsonb_array_elements(COALESCE(v_envios, '[]'::jsonb)) LOOP
        -- Solo tomas de ESTE item (y del batch pedido si vino).
        IF COALESCE(v_envio->>'item_id', '') <> p_item_id::text THEN CONTINUE; END IF;
        IF p_batch_uuid IS NOT NULL AND TRIM(p_batch_uuid) <> ''
           AND COALESCE(v_envio->>'lote', '') <> TRIM(p_batch_uuid) THEN CONTINUE; END IF;
        -- Solo tomas ATENDIDAS (no las reversas ya existentes).
        v_ruta := COALESCE(v_envio->>'destino', '');
        IF v_ruta NOT IN ('atencion', 'atencion_posicion') THEN CONTINUE; END IF;
        IF COALESCE(v_envio->>'reversa_de', '') <> '' THEN CONTINUE; END IF;

        v_toma_uuid := COALESCE(v_envio->>'uuid', '');
        v_candidatas := v_candidatas + 1;
        -- Idempotencia POR TOMA: si esta toma ya tiene su reversa, saltarla
        -- (permite revertir lotes distintos por separado sin falsos duplicados).
        IF EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_envios) AS r
          WHERE r->>'reversa_de' = v_toma_uuid
        ) THEN
          CONTINUE;
        END IF;
        v_toma_actual := v_toma_uuid;
        v_reversa_de := v_toma_uuid;
        v_uuid_reversa := gen_random_uuid()::text;
        v_lote_reversa := 'REV-' || COALESCE(COALESCE(v_envio->>'lote', v_toma_uuid), '');

        IF v_ruta = 'atencion' THEN
          -- Ruta TRÁNSITO: compensación negativa → el pendiente de la guía vuelve.
          v_cant := COALESCE((v_envio->>'cantidad')::numeric, 0);
          v_total_revertido := v_total_revertido + v_cant;
          v_nuevo_envio := jsonb_build_object(
            'uuid', v_uuid_reversa,
            'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
            'destino', 'reversa_atencion',
            'ubicacion', '',
            'cantidad', -v_cant,
            'usuario_id', p_usuario_id,
            'usuario_nombre', p_usuario_nombre,
            'turno', p_turno,
            'rack', NULL,
            'piso', NULL,
            'rq', v_rq.numero_rq,
            'item_id', p_item_id,
            'lote', v_lote_reversa,
            'reversa_de', v_reversa_de
          );
        ELSE
          -- Ruta POSICIÓN: INGRESO compensatorio en la MISMA ubicación con el
          -- lote de la fila de Recepción (cantidad exacta de la toma).
          v_cant := COALESCE((v_envio->>'cantidad_atencion')::numeric, 0);
          v_total_revertido := v_total_revertido + v_cant;
          IF v_envio->'rack' IS NOT NULL AND COALESCE(v_envio->'rack'->>'bloque', '') <> '' THEN
            v_res := public.registrar_movimiento_kardex(
              'ingreso',
              v_envio->'rack'->>'bloque', v_envio->'rack'->>'torre', v_envio->'rack'->>'piso', v_envio->'rack'->>'posicion',
              v_codigo_item, v_fila.descripcion, v_fila.unidad_medida, v_cant,
              v_fila.fecha_vencimiento, p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo,
              v_fila.proveedor, v_uuid_reversa, NULL, NULLIF(TRIM(COALESCE(v_fila.lote, '')), '')
            );
          ELSIF v_envio->'piso' IS NOT NULL AND COALESCE(v_envio->'piso'->>'nivel_id', '') <> '' THEN
            SELECT id INTO v_bloque_piso_id FROM piso_bloques WHERE codigo = v_codigo_item;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'BLOQUE_PISO_NO_EXISTE|Toma %: no existe bloque Piso para el código %', v_toma_uuid, v_item.codigo;
            END IF;
            INSERT INTO piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, posicion_id)
            VALUES ('ingreso', p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo, v_uuid_reversa,
                    NULLIF(v_envio->'piso'->>'posicion_id', '')::uuid)
            RETURNING id INTO v_mov_id;
            INSERT INTO piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
            VALUES (v_mov_id, (v_envio->'piso'->>'nivel_id')::uuid, v_bloque_piso_id, v_cant,
                    v_fila.fecha_vencimiento, NULLIF(TRIM(COALESCE(v_fila.lote, '')), ''));
          ELSE
            RAISE EXCEPTION 'UBICACION_REQUERIDA|Toma % sin ubicación para reingresar', v_toma_uuid;
          END IF;
          v_nuevo_envio := jsonb_build_object(
            'uuid', v_uuid_reversa,
            'fecha', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
            'destino', 'reversa_atencion',
            'ubicacion', COALESCE(v_envio->>'ubicacion', ''),
            'cantidad', 0,
            'cantidad_atencion', -v_cant,
            'usuario_id', p_usuario_id,
            'usuario_nombre', p_usuario_nombre,
            'turno', p_turno,
            'rack', v_envio->'rack',
            'piso', v_envio->'piso',
            'rq', v_rq.numero_rq,
            'item_id', p_item_id,
            'lote', v_lote_reversa,
            'reversa_de', v_reversa_de
          );
        END IF;

        UPDATE recepcion_registros
          SET transito = jsonb_build_object(
                'v', 1,
                'envios', (COALESCE(transito->'envios', '[]'::jsonb) || jsonb_build_array(v_nuevo_envio)))
          WHERE id = v_rid;

        -- v3 (Task 27): la reversa queda en el ledger (cantidad −).
        INSERT INTO rq_atencion_tomas
          (rq_id, item_id, codigo, origen, cantidad, ubicacion, rack, piso, lote, usuario_id, usuario_nombre, usuario_correo, turno)
        VALUES
          (v_item.rq_id, p_item_id, v_codigo_item, 'reversa', -v_cant,
           rq_ubicacion_texto(v_envio->'rack', v_envio->'piso', v_envio->>'ubicacion'),
           v_envio->'rack', v_envio->'piso', v_lote_reversa,
           p_usuario_id, p_usuario_nombre, p_usuario_correo, p_turno);

        v_tomas_revertidas := v_tomas_revertidas + 1;
      END LOOP;
    END LOOP;

    IF v_tomas_revertidas = 0 THEN
      IF v_candidatas > 0 THEN
        -- Todas las tomas candidatas ya estaban revertidas → éxito idempotente.
        RETURN jsonb_build_object('ok', true, 'duplicado', true, 'total_revertido', 0);
      END IF;
      RAISE EXCEPTION 'LOTE_NO_ENCONTRADO|No se encontró ninguna toma activa para revertir';
    END IF;

    -- Ítem: devolver lo atendido (piso 0) + estado del encabezado (3 vías).
    v_nuevo := GREATEST(v_item.cantidad_atendida - v_total_revertido, 0);
    UPDATE rq_atencion_items SET
      cantidad_atendida = v_nuevo,
      atendido_en = CASE WHEN v_nuevo >= v_item.cantidad THEN v_item.atendido_en ELSE NULL END
    WHERE id = p_item_id;

    SELECT COUNT(*) INTO v_pendientes
      FROM rq_atencion_items WHERE rq_id = v_item.rq_id AND cantidad_atendida < cantidad;
    SELECT COUNT(*) INTO v_total_items FROM rq_atencion_items WHERE rq_id = v_item.rq_id;
    v_estado_rq := CASE
      WHEN v_pendientes = 0 THEN 'Atendido'
      WHEN v_pendientes = v_total_items THEN 'Pendiente'
      ELSE 'En proceso' END;
    UPDATE rq_atenciones SET estado = v_estado_rq WHERE id = v_item.rq_id;

    RETURN jsonb_build_object(
      'ok', true,
      'duplicado', false,
      'total_revertido', v_total_revertido,
      'tomas_revertidas', v_tomas_revertidas,
      'nuevo_atendido', v_nuevo,
      'estado_rq', v_estado_rq
    );

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_sqlerrm = MESSAGE_TEXT;
    v_pipe := position('|' in v_sqlerrm);
    IF v_pipe > 1 THEN
      v_code := substring(v_sqlerrm from 1 for v_pipe - 1);
      v_msg := substring(v_sqlerrm from v_pipe + 1);
    ELSE
      v_code := v_sqlstate;
      v_msg := v_sqlerrm;
    END IF;
    RETURN jsonb_build_object('ok', false, 'fallo', jsonb_build_object(
      'codigo', v_code, 'mensaje', v_msg, 'toma', v_toma_actual
    ));
  END;
END;
$function$


-- ── RPC: rq_editar_rq → permiso atencion.editar (plpgsql) ──
CREATE OR REPLACE FUNCTION public.rq_editar_rq(p_rq_id uuid, p_encabezado jsonb DEFAULT '{}'::jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_usuario_id uuid DEFAULT NULL::uuid, p_usuario_nombre text DEFAULT ''::text, p_usuario_correo text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rq            rq_atenciones%ROWTYPE;
  v_rq_json       jsonb;
  v_roles         text[] := ARRAY['admin','supervisor_almacen',
                                  'supervisor_operaciones','coordinador_operaciones'];
  v_item          rq_atencion_items%ROWTYPE;
  v_fila          jsonb;
  v_id            uuid;
  v_txt           text;
  v_fecha         date;
  v_codigo        text;
  v_desc          text;
  v_unidad        text;
  v_orden         int;
  v_cant          numeric;
  v_diff          jsonb := '[]'::jsonb;
  v_alguno_atendido boolean;
  v_ids_payload   uuid[] := ARRAY[]::uuid[];
  v_ids_rq        uuid[] := ARRAY[]::uuid[];
  v_ids_borrar    uuid[] := ARRAY[]::uuid[];
  v_n_enc         int := 0;
  v_n_upd         int := 0;
  v_n_ins         int := 0;
  v_n_del         int := 0;
  v_pendientes    int;
  v_total_items   int;
  v_estado        text;
  v_estado_antes  text;
  v_cambio        jsonb;
  v_cambios_total int;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'atencion.editar') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para editar solicitudes (RQ)';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  -- ── 1) Guard de rol (mismos roles que pueden ELIMINAR la RQ) ──────────
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL; -- operaciones internas del sistema
  ELSIF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden editar una RQ';
  ELSIF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role::text = ANY (v_roles)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo supervisores o administradores pueden editar una RQ';
  END IF;

  -- ── 2) RQ existente, bloqueada contra carreras ────────────────────────
  IF p_rq_id IS NULL THEN
    RAISE EXCEPTION 'RQ_NO_EXISTE|Falta el identificador de la RQ';
  END IF;
  SELECT * INTO v_rq FROM rq_atenciones WHERE id = p_rq_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RQ_NO_EXISTE|La RQ ya no existe (puede haber sido eliminada)';
  END IF;
  v_estado_antes := v_rq.estado;
  v_rq_json := to_jsonb(v_rq);  -- lectura genérica campo-por-campo (dif de encabezado)

  -- ── 3) Encabezado: aplica SOLO los campos presentes ───────────────────
  -- numero_rq / orden_produccion / producto_codigo / producto_descripcion /
  -- linea / solicitante / notas  (texto, trim; NOTA permite vacío)
  FOREACH v_txt IN ARRAY ARRAY['numero_rq','orden_produccion','producto_codigo',
                               'producto_descripcion','linea','solicitante'] LOOP
    IF p_encabezado ? v_txt THEN
      DECLARE
        v_nuevo text := TRIM(COALESCE(p_encabezado ->> v_txt, ''));
      BEGIN
        IF v_nuevo IS DISTINCT FROM (v_rq_json ->> v_txt) THEN
          v_diff := v_diff || jsonb_build_object(
            'tipo','encabezado', 'campo', v_txt,
            'antes', COALESCE(v_rq_json ->> v_txt, ''),
            'despues', v_nuevo);
          EXECUTE format('UPDATE rq_atenciones SET %I = $1 WHERE id = $2', v_txt)
            USING v_nuevo, p_rq_id;
          v_rq_json := v_rq_json || jsonb_build_object(v_txt, v_nuevo);
          v_n_enc := v_n_enc + 1;
        END IF;
      END;
    END IF;
  END LOOP;
  -- notas: permite vacío a propósito (limpiar la nota es una corrección válida)
  IF p_encabezado ? 'notas' THEN
    v_txt := COALESCE(p_encabezado ->> 'notas', '');
    IF v_txt IS DISTINCT FROM (v_rq_json ->> 'notas') THEN
      v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','notas',
        'antes', COALESCE(v_rq_json ->> 'notas', ''), 'despues', v_txt);
      UPDATE rq_atenciones SET notas = v_txt WHERE id = p_rq_id;
      v_rq_json := v_rq_json || jsonb_build_object('notas', v_txt);
      v_n_enc := v_n_enc + 1;
    END IF;
  END IF;
  -- fecha (valida formato YYYY-MM-DD)
  IF p_encabezado ? 'fecha' THEN
    v_txt := TRIM(COALESCE(p_encabezado ->> 'fecha', ''));
    IF v_txt <> '' AND v_txt IS DISTINCT FROM (v_rq_json ->> 'fecha') THEN
      BEGIN
        v_fecha := v_txt::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'FECHA_INVALIDA|La fecha "%" no es válida (usa AAAA-MM-DD)', v_txt;
      END;
      v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','fecha',
        'antes', COALESCE(v_rq_json ->> 'fecha', ''), 'despues', v_txt);
      UPDATE rq_atenciones SET fecha = v_fecha WHERE id = p_rq_id;
      v_rq_json := v_rq_json || jsonb_build_object('fecha', v_txt);
      v_n_enc := v_n_enc + 1;
    END IF;
  END IF;
  -- turno (T1/T2)
  IF p_encabezado ? 'turno' THEN
    v_txt := TRIM(COALESCE(p_encabezado ->> 'turno', ''));
    IF v_txt <> '' AND v_txt IS DISTINCT FROM (v_rq_json ->> 'turno') THEN
      IF v_txt NOT IN ('T1','T2') THEN
        RAISE EXCEPTION 'TURNO_INVALIDO|El turno debe ser T1 o T2 (recibido: "%")', v_txt;
      END IF;
      v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','turno',
        'antes', COALESCE(v_rq_json ->> 'turno', ''), 'despues', v_txt);
      UPDATE rq_atenciones SET turno = v_txt WHERE id = p_rq_id;
      v_rq_json := v_rq_json || jsonb_build_object('turno', v_txt);
      v_n_enc := v_n_enc + 1;
    END IF;
  END IF;
  -- Task 35: turno del RQ según la hoja física (004=T1, 005=T2). Nullable:
  -- '' (vacío) = sin indicar → guarda NULL; histórico NULL + valor T1/T2 =
  -- backfill. La comparación usa COALESCE para tratar NULL y '' como iguales.
  IF p_encabezado ? 'turno_rq' THEN
    v_txt := TRIM(COALESCE(p_encabezado ->> 'turno_rq', ''));
    IF v_txt <> '' AND v_txt NOT IN ('T1','T2') THEN
      RAISE EXCEPTION 'TURNO_RQ_INVALIDO|El turno del RQ debe ser T1, T2 o vacío (recibido: "%")', v_txt;
    END IF;
    IF v_txt IS DISTINCT FROM COALESCE(v_rq_json ->> 'turno_rq', '') THEN
      v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','turnoRq',
        'antes', COALESCE(v_rq_json ->> 'turno_rq', ''), 'despues', v_txt);
      UPDATE rq_atenciones SET turno_rq = NULLIF(v_txt, '') WHERE id = p_rq_id;
      v_rq_json := v_rq_json || jsonb_build_object('turno_rq', v_txt);
      v_n_enc := v_n_enc + 1;
    END IF;
  END IF;

  -- ── 4) Items: estado deseado COMPLETO (diff declarativo) ─────────────
  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' AND jsonb_array_length(p_items) > 0 THEN
    IF jsonb_array_length(p_items) > 500 THEN
      RAISE EXCEPTION 'DEMASIADOS_ITEMS|Una RQ admite como máximo 500 materiales';
    END IF;

    -- 4.a) Updates (filas CON id) + colección de ids presentes
    FOR v_fila IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_id := NULLIF(TRIM(COALESCE(v_fila ->> 'id', '')), '');
      IF v_id IS NULL THEN CONTINUE; END IF;
      IF v_id::uuid = ANY (v_ids_payload) THEN
        RAISE EXCEPTION 'ITEM_DUPLICADO|El material % viene dos veces en la edición', v_id;
      END IF;
      v_ids_payload := v_ids_payload || v_id::uuid;

      SELECT * INTO v_item FROM rq_atencion_items
        WHERE id = v_id::uuid AND rq_id = p_rq_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ITEM_NO_EXISTE|Un material de la edición ya no pertenece a esta RQ (recarga la pantalla e inténtalo de nuevo)';
      END IF;

      v_codigo := UPPER(TRIM(COALESCE(v_fila ->> 'codigo', v_item.codigo)));
      IF v_codigo = '' THEN
        RAISE EXCEPTION 'CODIGO_REQUERIDO|Hay materiales sin código';
      END IF;
      v_cant := COALESCE((v_fila ->> 'cantidad')::numeric, v_item.cantidad);
      IF v_cant IS NULL OR v_cant <= 0 THEN
        RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad de % debe ser mayor que cero', v_codigo;
      END IF;
      -- Task 34: solo rechaza si la edición CAMBIA la cantidad a algo menor
      -- que lo atendido. Un item SOBREATENDIDO sin modificar (atendió más de
      -- lo pedido — permitido por rq_atender_item) debe pasar tal cual: antes
      -- la regla manta dejaba ineditables TODAS las RQ con sobreatención.
      IF v_cant <> v_item.cantidad AND v_cant < v_item.cantidad_atendida THEN
        RAISE EXCEPTION 'CANTIDAD_MENOR_ATENDIDA|% pide % pero ya se atendieron %: primero revierte la atención de ese material',
          v_codigo, v_cant, v_item.cantidad_atendida;
      END IF;
      v_unidad := TRIM(COALESCE(v_fila ->> 'unidad', v_item.unidad));
      IF v_unidad = '' THEN v_unidad := v_item.unidad; END IF;
      v_desc := COALESCE(v_fila ->> 'descripcion', v_item.descripcion);
      v_orden := COALESCE((v_fila ->> 'orden')::int, v_item.orden);

      -- Identidad congelada si hubo salida física (la atención quedó atada
      -- a ESE código/unidad): cambiarlos corrompería el rastro del material.
      IF v_item.cantidad_atendida > 0
         AND (v_codigo <> UPPER(TRIM(v_item.codigo)) OR v_unidad <> v_item.unidad) THEN
        RAISE EXCEPTION 'ITEM_CON_ATENCION|% ya tiene % atendidos: revierte su atención antes de cambiar el código o la unidad',
          v_item.codigo, v_item.cantidad_atendida;
      END IF;

      IF v_codigo <> v_item.codigo OR v_desc IS DISTINCT FROM v_item.descripcion
         OR v_unidad <> v_item.unidad OR v_cant <> v_item.cantidad
         OR v_orden <> v_item.orden THEN
        IF v_cant <> v_item.cantidad THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_item.codigo,
            'campo','cantidad','antes',v_item.cantidad,'despues',v_cant);
        END IF;
        IF v_codigo <> v_item.codigo THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_item.codigo,
            'campo','codigo','antes',v_item.codigo,'despues',v_codigo);
        END IF;
        IF v_unidad <> v_item.unidad THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_codigo,
            'campo','unidad','antes',v_item.unidad,'despues',v_unidad);
        END IF;
        IF v_desc IS DISTINCT FROM v_item.descripcion THEN
          v_diff := v_diff || jsonb_build_object('tipo','material','item',v_codigo,
            'campo','descripcion','antes',v_item.descripcion,'despues',v_desc);
        END IF;
        UPDATE rq_atencion_items SET
          codigo = v_codigo, descripcion = v_desc, unidad = v_unidad,
          cantidad = v_cant, orden = v_orden
        WHERE id = v_item.id;
        v_n_upd := v_n_upd + 1;
      END IF;
    END LOOP;

    -- 4.b) Deletes (items de la RQ AUSENTES del payload)
    SELECT array_agg(id ORDER BY id) INTO v_ids_rq
      FROM rq_atencion_items WHERE rq_id = p_rq_id;
    SELECT array_agg(x ORDER BY x) INTO v_ids_borrar
      FROM unnest(COALESCE(v_ids_rq, ARRAY[]::uuid[])) AS x
      WHERE NOT (x = ANY (v_ids_payload));
    FOREACH v_id IN ARRAY COALESCE(v_ids_borrar, ARRAY[]::uuid[]) LOOP
      SELECT * INTO v_item FROM rq_atencion_items WHERE id = v_id FOR UPDATE;
      IF v_item.cantidad_atendida > 0 THEN
        RAISE EXCEPTION 'ITEM_CON_ATENCION|% tiene % atendidos: revierte su atención antes de quitarlo de la RQ',
          v_item.codigo, v_item.cantidad_atendida;
      END IF;
      DELETE FROM rq_atencion_items WHERE id = v_item.id;
      v_diff := v_diff || jsonb_build_object('tipo','material_quitado','item',v_item.codigo,
        'descripcion',v_item.descripcion,'cantidad',v_item.cantidad,'unidad',v_item.unidad);
      v_n_del := v_n_del + 1;
    END LOOP;

    -- 4.c) Inserts (filas SIN id = materiales nuevos)
    FOR v_fila IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_id := NULLIF(TRIM(COALESCE(v_fila ->> 'id', '')), '');
      IF v_id IS NOT NULL THEN CONTINUE; END IF;
      v_codigo := UPPER(TRIM(COALESCE(v_fila ->> 'codigo', '')));
      IF v_codigo = '' THEN
        RAISE EXCEPTION 'CODIGO_REQUERIDO|Hay materiales nuevos sin código';
      END IF;
      v_cant := COALESCE((v_fila ->> 'cantidad')::numeric, 0);
      IF v_cant IS NULL OR v_cant <= 0 THEN
        RAISE EXCEPTION 'CANTIDAD_INVALIDA|La cantidad de % debe ser mayor que cero', v_codigo;
      END IF;
      v_unidad := TRIM(COALESCE(v_fila ->> 'unidad', ''));
      v_desc   := TRIM(COALESCE(v_fila ->> 'descripcion', ''));
      v_orden  := COALESCE((v_fila ->> 'orden')::int,
                           (SELECT COALESCE(MAX(orden), -1) + 1
                              FROM rq_atencion_items WHERE rq_id = p_rq_id));
      INSERT INTO rq_atencion_items
        (rq_id, orden, codigo, descripcion, unidad, cantidad, cantidad_atendida)
      VALUES (p_rq_id, v_orden, v_codigo, v_desc, v_unidad, v_cant, 0)
      RETURNING * INTO v_item;
      v_n_ins := v_n_ins + 1;
      v_diff := v_diff || jsonb_build_object('tipo','material_agregado','item',v_codigo,
        'descripcion',v_desc,'cantidad',v_cant,'unidad',v_unidad);
    END LOOP;
  END IF;

  -- ── 5) Recalcula el estado del encabezado (regla canónica unificada) ──
  -- Atendido: nada pendiente · En proceso: hay algo atendido · Pendiente:
  -- nada atendido. Misma regla para rq_atender_item / rq_revertir_item
  -- (ver abajo): antes cada RPC tenía la suya y el estado divergía.
  SELECT count(*) INTO v_pendientes
    FROM rq_atencion_items
    WHERE rq_id = p_rq_id AND cantidad_atendida < cantidad;
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM rq_atencion_items WHERE rq_id = p_rq_id AND cantidad_atendida > 0
  ), false) INTO v_alguno_atendido;
  SELECT count(*) INTO v_total_items FROM rq_atencion_items WHERE rq_id = p_rq_id;
  v_estado := CASE
    WHEN v_total_items = 0 THEN v_estado_antes        -- sin materiales: no tocar
    WHEN v_pendientes = 0 THEN 'Atendido'
    WHEN v_alguno_atendido THEN 'En proceso'
    ELSE 'Pendiente' END;
  IF v_estado IS DISTINCT FROM v_estado_antes THEN
    v_diff := v_diff || jsonb_build_object('tipo','encabezado','campo','estado',
      'antes', v_estado_antes, 'despues', v_estado);
    v_n_enc := v_n_enc + 1;
  END IF;

  v_cambios_total := v_n_enc + v_n_upd + v_n_ins + v_n_del;

  -- ── 6) Auditoría (solo ediciones REALES; no-op no ensucia el historial) ─
  IF v_cambios_total > 0 THEN
    v_cambio := jsonb_build_object(
      'en', to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI'),
      'usuario_id',   COALESCE(p_usuario_id::text, ''),
      'usuario_nombre', COALESCE(NULLIF(TRIM(COALESCE(p_usuario_nombre,'')), ''), '—'),
      'usuario_correo', COALESCE(p_usuario_correo, ''),
      'resumen', jsonb_build_object(
        'encabezado', v_n_enc, 'materiales_editados', v_n_upd,
        'materiales_agregados', v_n_ins, 'materiales_quitados', v_n_del),
      'cambios', v_diff);
    UPDATE rq_atenciones SET
      estado = v_estado,
      ediciones = (
        SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (
          SELECT e FROM jsonb_array_elements(v_cambio || COALESCE(ediciones, '[]'::jsonb))
            WITH ORDINALITY AS t(e, ord) ORDER BY ord LIMIT 20
        ) ultimas
      )
    WHERE id = p_rq_id;
  END IF;

  -- ── 7) Resultado: RQ + items + nº de cambios aplicados ────────────────
  RETURN jsonb_build_object(
    'rq', (SELECT to_jsonb(r) FROM rq_atenciones r WHERE r.id = p_rq_id),
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(it) ORDER BY it.orden, it.created_at)
        FROM rq_atencion_items it WHERE it.rq_id = p_rq_id
    ), '[]'::jsonb),
    'cambios', v_cambios_total);
END
$function$


-- ── RPC: ral_crear_completa → permiso atencion.crear (plpgsql) ──
CREATE OR REPLACE FUNCTION public.ral_crear_completa(p_ral jsonb, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id   uuid;
  v_item jsonb;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'atencion.crear') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para crear RAL';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  v_id := (p_ral->>'id')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'ID_REQUERIDO|el RAL debe traer id preasignado (idempotencia)';
  END IF;

  INSERT INTO rals (
    id, fecha, documento, transaccion, area_solicitante, solicitante,
    aprobado_por, almacen, linea, foto_url, notas,
    usuario_id, usuario_nombre, usuario_correo
  ) VALUES (
    v_id,
    coalesce((p_ral->>'fecha')::date, current_date),
    coalesce(p_ral->>'documento', ''),
    coalesce(p_ral->>'transaccion', ''),
    coalesce(p_ral->>'area_solicitante', ''),
    coalesce(p_ral->>'solicitante', ''),
    coalesce(p_ral->>'aprobado_por', ''),
    coalesce(p_ral->>'almacen', ''),
    coalesce(p_ral->>'linea', ''),
    coalesce(p_ral->>'foto_url', ''),
    coalesce(p_ral->>'notas', ''),
    coalesce(NULLIF(btrim(coalesce(p_ral->>'usuario_id','')), '')::uuid,
             '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(p_ral->>'usuario_nombre', ''),
    coalesce(p_ral->>'usuario_correo', '')
  )
  ON CONFLICT (id) DO NOTHING;

  -- Items: inserta SOLO los que faltan (idempotente ante reintento).
  -- Llave natural de reenvío: (ral_id, orden, codigo) — igual que la RQ.
  FOR v_item IN
    SELECT * FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
    )
  LOOP
    INSERT INTO ral_items (
      ral_id, orden, codigo, descripcion, unidad, centro_costos, cantidad
    )
    SELECT
      v_id,
      coalesce((v_item->>'orden')::int, 0),
      coalesce(v_item->>'codigo', ''),
      coalesce(v_item->>'descripcion', ''),
      coalesce(v_item->>'unidad', ''),
      coalesce(v_item->>'centro_costos', ''),
      coalesce((v_item->>'cantidad')::numeric, 0)
    WHERE NOT EXISTS (
      SELECT 1 FROM ral_items x
      WHERE x.ral_id  = v_id
        AND x.orden   = coalesce((v_item->>'orden')::int, 0)
        AND x.codigo  = coalesce(v_item->>'codigo', '')
    );
  END LOOP;

  RETURN v_id;
END;
$function$


-- ── RPC: transito_registrar_envio → permiso transito.crear (plpgsql) ──
CREATE OR REPLACE FUNCTION public.transito_registrar_envio(p_recepcion_id uuid, p_tipo_destino text, p_cantidad numeric, p_turno text, p_usuario_id uuid, p_usuario_nombre text, p_usuario_correo text, p_uuid_sync text, p_rack jsonb DEFAULT NULL::jsonb, p_piso jsonb DEFAULT NULL::jsonb, p_ubicacion text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.recepcion_registros%rowtype;
  v_envios jsonb;
  v_enviados numeric;
  v_pendiente numeric;
  v_nuevo jsonb;
  v_lote text;
  v_venc date;
  v_codigo text;
  v_descripcion text;
  v_un text;
  v_prov text;
  v_res jsonb;
  v_mov_id uuid;
  v_bloque_piso_id uuid;
begin
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'transito.crear') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para registrar envíos de tránsito';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  -- GUARD de autorización: la RPC es SECURITY DEFINER (escribe en movimientos,
  -- piso_movimientos, recepcion_registros). Nunca ejecutable por anon.
  if coalesce(auth.role(), '') not in ('service_role', 'authenticated') then
    raise exception 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar envíos de Tránsito';
  end if;

  if p_tipo_destino not in ('rack', 'piso') then
    raise exception 'DESTINO_INVALIDO|El destino debe ser rack o piso (recibido: %)', p_tipo_destino;
  end if;
  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'CANTIDAD_INVALIDA|La cantidad a transferir debe ser mayor que cero';
  end if;
  if p_uuid_sync is null or trim(p_uuid_sync) = '' then
    raise exception 'UUID_REQUERIDO|Falta el identificador único del envío';
  end if;

  -- Lock por fila de recepción: dos envíos simultáneos del mismo artículo se
  -- serializan y el anti-sobreenvío siempre ve el total real.
  perform pg_advisory_xact_lock(hashtextextended(p_recepcion_id::text, 7771));

  select * into v_row from public.recepcion_registros where id = p_recepcion_id;
  if not found then
    raise exception 'RECEPCION_NO_EXISTE|La fila de recepción ya no existe';
  end if;

  v_envios := coalesce(v_row.transito -> 'envios', '[]'::jsonb);

  -- IDEMPOTENCIA: mismo uuid del envío => ya registrado, devolver éxito sin tocar nada
  if exists (
    select 1 from jsonb_array_elements(v_envios) as e
    where e ->> 'uuid' = p_uuid_sync
  ) then
    return jsonb_build_object('ok', true, 'duplicado', true, 'recepcion_id', p_recepcion_id);
  end if;

  -- ANTI-SOBREENVÍO: lo enviado no puede superar la cantidad registrada.
  -- v9 (auditoría 2026-10-30, E2): EPS 0.0005 igual que el cliente — un
  -- pendiente con residuo binario (p. ej. 80.0000001) no rechaza un envío
  -- de 80 que la UI sí acepta.
  select coalesce(sum((e ->> 'cantidad')::numeric), 0) into v_enviados
  from jsonb_array_elements(v_envios) as e;
  v_pendiente := v_row.cantidad - v_enviados;
  if p_cantidad > v_pendiente + 0.0005 then
    raise exception 'OVER_ISSUE|La cantidad a transferir (%) excede el pendiente de % (%): excedente %',
      p_cantidad, v_row.codigo, v_pendiente, (p_cantidad - v_pendiente);
  end if;

  -- Regla TRÁNSITO (v2 2026-10-20): SIN lote o SIN fecha de vencimiento ya NO
  -- bloquea. El proveedor a veces no trae esos datos; se transfieren CON
  -- confirmación explícita en la UI y luego se completan/corrigen con
  -- editar_lote (v1/v2) en Racks/Piso. lote='' se normaliza a NULL abajo.

  v_lote := trim(coalesce(v_row.lote, ''));

  -- v8 (auditoría 2026-10-23): si la fila de Recepción trae un vencimiento con
  -- año absurdo (typo histórico: 0202/3027/…), NO se propaga a Racks/Piso:
  -- viaja como sin fecha (la regla v2 ya permite transferir sin fecha con
  -- confirmación) y el flujo de tránsito NO se bloquea. La fila original se
  -- corrige en Recepción / editar_lote.
  v_venc := v_row.fecha_vencimiento;
  -- FIX 2026-10-30: la asignación DEBE ir ANTES del guard v8 — estaba
  -- después y el check corría sobre NULL (código muerto): los
  -- vencimientos absurdos pasaban crudos y FECHA_INVALIDA bloqueaba
  -- la transferencia en vez de viajar «sin fecha» como diseñó v8.
  if v_venc is not null and
     (extract(year from v_venc) < 2000 or extract(year from v_venc) > 2100) then
    v_venc := null;
  end if;

  v_codigo := upper(trim(v_row.codigo));
  v_descripcion := v_row.descripcion;
  v_un := v_row.unidad_medida;
  v_prov := v_row.proveedor;

  if p_tipo_destino = 'rack' then
    if p_rack is null or coalesce(p_rack ->> 'bloque', '') = '' then
      raise exception 'UBICACION_RACK_REQUERIDA|Falta la ubicación del rack (bloque/torre/piso/posición)';
    end if;
    -- Ingreso NATIVO en Racks (misma RPC que usa el módulo) — misma transacción:
    -- si esto falla, NO se marca nada en Tránsito. Acepta v_venc NULL y
    -- lote NULL ('' → NULLIF: "sin lote" en un solo convenio).
    v_res := public.registrar_movimiento_kardex(
      'ingreso',
      p_rack ->> 'bloque', p_rack ->> 'torre', p_rack ->> 'piso', p_rack ->> 'posicion',
      v_codigo, v_descripcion, v_un, p_cantidad, v_venc, p_turno,
      p_usuario_id, p_usuario_nombre, p_usuario_correo, v_prov,
      p_uuid_sync, null, nullif(v_lote, '')
    );
  else
    if p_piso is null or coalesce(p_piso ->> 'nivel_id', '') = '' then
      raise exception 'UBICACION_PISO_REQUERIDA|Falta el nivel de destino del piso';
    end if;

    -- Bloque del catálogo Piso: resolver por código; crearlo si no existe
    -- (puente Recepción → Piso sin doble digitación).
    select id into v_bloque_piso_id from public.piso_bloques where codigo = v_codigo;
    if not found then
      insert into public.piso_bloques (codigo, descripcion, unidad)
      values (v_codigo, v_descripcion, v_un)
      on conflict (codigo) do nothing;
      select id into v_bloque_piso_id from public.piso_bloques where codigo = v_codigo;
    end if;

    -- Ingreso NATIVO en Piso (cabecera + detalle, igual que registrarIngresoPosicion).
    -- fecha_vencimiento y lote son nullable: NULL = sin dato (se completa luego).
    insert into public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, posicion_id)
    values (
      'ingreso', p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo,
      p_uuid_sync, nullif(p_piso ->> 'posicion_id', '')::uuid
    ) returning id into v_mov_id;

    insert into public.piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    values (v_mov_id, (p_piso ->> 'nivel_id')::uuid, v_bloque_piso_id, p_cantidad, v_venc, nullif(v_lote, ''));
  end if;

  -- Marca TRÁNSITO sobre la fila de recepción (historial completo por artículo)
  v_nuevo := jsonb_build_object(
    'uuid', p_uuid_sync,
    'fecha', to_char(now() at time zone 'America/Lima', 'YYYY-MM-DD HH24:MI'),
    'destino', p_tipo_destino,
    'ubicacion', coalesce(p_ubicacion, ''),
    'cantidad', p_cantidad,
    'usuario_id', p_usuario_id,
    'usuario_nombre', p_usuario_nombre,
    'turno', p_turno,
    'rack', p_rack,
    'piso', p_piso
  );
  update public.recepcion_registros
  set transito = jsonb_build_object('v', 1, 'envios', (v_envios || jsonb_build_array(v_nuevo)))
  where id = p_recepcion_id;

  v_enviados := v_enviados + p_cantidad;
  v_pendiente := v_row.cantidad - v_enviados;
  return jsonb_build_object(
    'ok', true,
    'duplicado', false,
    'recepcion_id', p_recepcion_id,
    'enviados', v_enviados,
    'pendiente', v_pendiente,
    'estado', case when v_pendiente <= 0 then 'COMPLETO' else 'PARCIAL' end
  );
end;
$function$


-- ── RPC: rackly_reemplazar_movimientos → permiso descarga.subir (plpgsql) ──
CREATE OR REPLACE FUNCTION public.rackly_reemplazar_movimientos(_movimientos jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE
  v_mov JSONB;
  v_count INTEGER := 0;
  v_fecha DATE;
BEGIN
  -- __guard_permiso__: cuadro de permisos (denegar funciona también por RPC)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(current_setting('rackly.en_rpc_interna', true), '') = '1' THEN
    NULL; -- llamada anidada desde otra RPC ya autorizada (hereda su guard)
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR NOT public.tiene_permiso(auth.uid(), 'descarga.subir') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|No tienes permiso para usar UP Data';
    END IF;
  END IF;
  PERFORM set_config('rackly.en_rpc_interna', '1', true);

  DELETE FROM public.movimientos;
  FOR v_mov IN SELECT * FROM jsonb_array_elements(_movimientos)
  LOOP
    BEGIN
      v_fecha := NULL;
      IF v_mov->>'f_vencimiento' IS NOT NULL
         AND (v_mov->>'f_vencimiento') != ''
         AND (v_mov->>'f_vencimiento') != 'null' THEN
        v_fecha := to_date(v_mov->>'f_vencimiento', 'YYYY-MM-DD');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        v_fecha := (v_mov->>'f_vencimiento')::TIMESTAMPTZ::DATE;
      EXCEPTION WHEN OTHERS THEN
        v_fecha := NULL;
      END;
    END;
    INSERT INTO public.movimientos (
      tipo, bloque, torre, piso, posicion, codigo, descripcion, un,
      cantidad, f_vencimiento, turno, usuario_id, usuario_nombre,
      usuario_correo, proveedor, codigo_inc
    ) VALUES (
      COALESCE(v_mov->>'tipo', 'ingreso'),
      v_mov->>'bloque',
      v_mov->>'torre',
      v_mov->>'piso',
      v_mov->>'posicion',
      UPPER(TRIM(COALESCE(v_mov->>'codigo', ''))),
      v_mov->>'descripcion',
      COALESCE(v_mov->>'un', 'KG'),
      COALESCE((v_mov->>'cantidad')::NUMERIC, 0),
      v_fecha,
      v_mov->>'turno',
      (v_mov->>'usuario_id')::UUID,
      v_mov->>'usuario_nombre',
      v_mov->>'usuario_correo',
      v_mov->>'proveedor',
      v_mov->>'codigo_inc'
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'count', v_count);
END;
 $function$

