-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · Migración 20261110 — ALMACÉN REPUESTOS (Fase 2: modelo de datos)
--
-- Crea la familia `rep_*` del almacén REPUESTOS: 7 tablas nuevas, sus
-- índices, triggers, la RPC atómica de ingreso y los 4 permisos nuevos
-- del cuadro. 100% ADITIVA: no modifica ninguna tabla ni función
-- existente (solo recrea con `create or replace` las 2 funciones del
-- cuadro de permisos ampliándolas, comportamiento previo intacto).
--
-- MODELO ACORDADO (Fase 0/1 con el usuario):
--   · Ubicación: piso → nivel → posición, con 4 tipos:
--       rack       = estantería (2 loncheras: A y B)
--       pasillo    = fila de pasillos del piso 1, BAJO el nivel 1 (nivel 0)
--       zona       = zonas de almacenamiento del tercer nivel
--       prepicking = zona temporal antes de la salida (1 lonchera por nivel)
--   · Contenedor: lonchera A/B; capacidad máx. 15 ARTÍCULOS DISTINTOS
--     por lonchera (la valida la RPC rep_registrar_ingreso y la UI).
--   · Regla "un artículo vive en una sola lonchera": unique
--     (lonchera_id, articulo_id) + aviso en la respuesta cuando ya está
--     en otra (excepción controlada acordada).
--   · Salidas: RAL que viene de BIG MAGIC (se registra, no se genera).
--   · Catálogo: carga Excel de 4 columnas; `cantidad_ref` es SOLO
--     REFERENCIA (no interfiere en stock ni movimientos).
--   · Sin lote ni vencimiento (el modelo los deja fuera a propósito).
--
-- SEGURIDAD (misma filosofía del hardening 2026 + cuadro de permisos):
--   · RLS habilitado en las 7 tablas; políticas para `authenticated`
--     gateadas por tiene_permiso() con los permisos nuevos:
--       repuestos.ver       → SELECT (todos los roles por defecto)
--       repuestos.crear     → INSERT + UPDATE operativo de stock (recepción)
--       repuestos.gestionar → UPDATE de catálogo/ubicaciones (supervisores+)
--       repuestos.eliminar  → DELETE (supervisores+)
--   · Privilegios revocados a `anon` (defensa en profundidad).
--   · Escrituras operativas atómicas vía RPC SECURITY DEFINER con guard
--     de permiso (patrón de las RPCs del kardex).
-- ═══════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 0) Extensión para búsqueda por descripción (25 000 filas)
-- ────────────────────────────────────────────────────────────────────
create extension if not exists pg_trgm;

-- ────────────────────────────────────────────────────────────────────
-- 1) rep_articulos — catálogo de repuestos (código = código BIG MAGIC)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.rep_articulos (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  codigo       text not null unique,
  descripcion  text not null default '',
  und          text not null default '',
  cantidad_ref numeric not null default 0,
  marca        text not null default '',
  modelo       text not null default '',
  aplicacion   text not null default '',
  activo       boolean not null default true
);

comment on table public.rep_articulos is
  'Repuestos: catalogo de articulos (codigo = BIG MAGIC). cantidad_ref es SOLO referencia del Excel inicial, no stock.';

create index if not exists idx_rep_articulos_desc_trgm
  on public.rep_articulos using gin (descripcion gin_trgm_ops);

-- ────────────────────────────────────────────────────────────────────
-- 2) rep_ubicaciones — layout físico (piso → nivel → posición)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.rep_ubicaciones (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tipo       text not null check (tipo in ('rack', 'pasillo', 'zona', 'prepicking')),
  piso       integer not null check (piso >= 1),
  nivel      integer not null check (nivel >= 0),
  secuencia  integer not null check (secuencia >= 1),
  codigo     text not null unique,
  nota       text not null default '',
  activo     boolean not null default true,
  unique (tipo, piso, nivel, secuencia)
);

comment on table public.rep_ubicaciones is
  'Repuestos: layout fisico. nivel 0 = fila de pasillos bajo el nivel 1 (solo piso 1). codigo normalizado ej. R-P1-N2-P05 / PAS-P1-01 / Z-P1-N3-01 / PP-P1-N1.';

create index if not exists idx_rep_ubicaciones_orden
  on public.rep_ubicaciones (tipo, piso, nivel, secuencia);

-- ────────────────────────────────────────────────────────────────────
-- 3) rep_loncheras — contenedores A/B de cada posición
--    (las crea el trigger; el usuario jamás las inserta a mano)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.rep_loncheras (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  ubicacion_id uuid not null references public.rep_ubicaciones (id) on delete cascade,
  lado         text not null check (lado in ('A', 'B')),
  unique (ubicacion_id, lado)
);

comment on table public.rep_loncheras is
  'Repuestos: contenedores por posicion. rack = A y B; pasillo/zona/prepicking = A.';

create index if not exists idx_rep_loncheras_ubicacion
  on public.rep_loncheras (ubicacion_id);

-- ────────────────────────────────────────────────────────────────────
-- 4) rep_ral + 5) rep_ral_detalle — documento de salida (BIG MAGIC)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.rep_ral (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  numero         text not null unique,
  fecha          date not null default current_date,
  solicitante    text not null default '',
  estado         text not null default 'registrado'
                 check (estado in ('registrado', 'despachado', 'anulado')),
  usuario_id     uuid,
  usuario_nombre text not null default ''
);

comment on table public.rep_ral is
  'Repuestos: documento RAL registrado desde BIG MAGIC (numero unico, no se genera en el app).';

create index if not exists idx_rep_ral_fecha
  on public.rep_ral (fecha desc, created_at desc);

create table if not exists public.rep_ral_detalle (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  ral_id      uuid not null references public.rep_ral (id) on delete cascade,
  articulo_id uuid not null references public.rep_articulos (id) on delete cascade,
  cantidad    numeric not null check (cantidad > 0),
  unique (ral_id, articulo_id)
);

comment on table public.rep_ral_detalle is
  'Repuestos: lineas del RAL (1..n articulos con cantidad solicitada).';

create index if not exists idx_rep_ral_detalle_ral
  on public.rep_ral_detalle (ral_id);
create index if not exists idx_rep_ral_detalle_articulo
  on public.rep_ral_detalle (articulo_id);

-- ────────────────────────────────────────────────────────────────────
-- 6) rep_stock — qué hay y en qué lonchera está
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.rep_stock (
  id          uuid primary key default gen_random_uuid(),
  updated_at  timestamptz not null default now(),
  lonchera_id uuid not null references public.rep_loncheras (id) on delete cascade,
  articulo_id uuid not null references public.rep_articulos (id) on delete cascade,
  cantidad    numeric not null check (cantidad >= 0),
  ral_id      uuid references public.rep_ral (id) on delete set null
);

comment on table public.rep_stock is
  'Repuestos: stock por lonchera. ral_id SOLO se llena mientras el articulo esta estacionado en prepicking (Tránsito).';

-- Un artículo: una sola fila por lonchera (la regla "vive en una sola
-- lonchera" se avisa en la RPC; la excepción controlada crea otra fila).
create unique index if not exists uq_rep_stock_lonchera_articulo
  on public.rep_stock (lonchera_id, articulo_id);
create index if not exists idx_rep_stock_articulo
  on public.rep_stock (articulo_id);
create index if not exists idx_rep_stock_en_transito
  on public.rep_stock (ral_id) where ral_id is not null;

-- ────────────────────────────────────────────────────────────────────
-- 7) rep_movimientos — kardex del almacén repuestos
--    (snapshot de codigo/descripcion: el kardex no se rompe si el
--     catálogo se edita después — patrón de movimientos de Insumos)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.rep_movimientos (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  tipo                 text not null
                       check (tipo in ('ingreso', 'salida', 'devolucion', 'traslado', 'ajuste')),
  articulo_id          uuid not null references public.rep_articulos (id),
  codigo               text not null default '',
  descripcion          text not null default '',
  und                  text not null default '',
  cantidad             numeric not null,
  origen_ubicacion_id  uuid references public.rep_ubicaciones (id),
  origen_lado          text check (origen_lado in ('A', 'B')),
  destino_ubicacion_id uuid references public.rep_ubicaciones (id),
  destino_lado         text check (destino_lado in ('A', 'B')),
  ral_id               uuid references public.rep_ral (id),
  referencia           text not null default '',
  usuario_id           uuid,
  usuario_nombre       text not null default ''
);

comment on table public.rep_movimientos is
  'Repuestos: kardex. Cada salto (ingreso/salida/devolucion/traslado/ajuste) registra origen→destino, RAL y usuario.';

create index if not exists idx_rep_movs_created
  on public.rep_movimientos (created_at desc);
create index if not exists idx_rep_movs_articulo
  on public.rep_movimientos (articulo_id, created_at desc);
create index if not exists idx_rep_movs_codigo
  on public.rep_movimientos (codigo);
create index if not exists idx_rep_movs_ral
  on public.rep_movimientos (ral_id) where ral_id is not null;

-- ────────────────────────────────────────────────────────────────────
-- 8) TRIGGERS — updated_at + creación automática de loncheras
-- ────────────────────────────────────────────────────────────────────
create or replace function public.rep_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_rep_articulos_touch on public.rep_articulos;
create trigger trg_rep_articulos_touch
  before update on public.rep_articulos
  for each row execute function public.rep_touch_updated_at();

drop trigger if exists trg_rep_stock_touch on public.rep_stock;
create trigger trg_rep_stock_touch
  before update on public.rep_stock
  for each row execute function public.rep_touch_updated_at();

-- Loncheras automáticas: rack → A+B, resto → A. SECURITY DEFINER para que
-- la creación no dependa de políticas INSERT (el usuario no las crea a mano).
create or replace function public.rep_crear_loncheras()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.rep_loncheras (ubicacion_id, lado)
  select new.id, l
  from unnest (
    case when new.tipo = 'rack' then array['A', 'B'] else array['A'] end
  ) as l
  on conflict (ubicacion_id, lado) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_rep_ubicaciones_loncheras on public.rep_ubicaciones;
create trigger trg_rep_ubicaciones_loncheras
  after insert on public.rep_ubicaciones
  for each row execute function public.rep_crear_loncheras();

-- ────────────────────────────────────────────────────────────────────
-- 9) RPC ATÓMICA rep_registrar_ingreso — recepción con validaciones
--    (capacidad 15 · artículo activo · aviso "ya vive en otra lonchera")
--    y kardex en UNA sola transacción. Patrón: RPCs SECURITY DEFINER
--    del kardex con guard de permiso.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.rep_registrar_ingreso(
  p_articulo_id uuid,
  p_lonchera_id uuid,
  p_cantidad    numeric,
  p_referencia  text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_art      public.rep_articulos;
  v_lado     text;
  v_ubic_id  uuid;
  v_ubic_cod text;
  v_ubic_tip text;
  v_existe   boolean;
  v_llena    boolean;
  v_en_otra  jsonb;
  v_mov_id   uuid;
begin
  -- Guard de permiso (service_role interno o usuario con repuestos.crear)
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.crear') then
      raise exception 'NO_AUTORIZADO|No tienes permiso para registrar ingresos en Repuestos';
    end if;
  end if;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'CANTIDAD_INVALIDA|La cantidad debe ser mayor que cero';
  end if;

  select * into v_art from public.rep_articulos where id = p_articulo_id;
  if not found then
    raise exception 'ARTICULO_NO_EXISTE|El artículo no existe en el catálogo de Repuestos';
  end if;
  if not v_art.activo then
    raise exception 'ARTICULO_INACTIVO|El artículo está inactivo en el catálogo';
  end if;

  select l.lado, u.id, u.codigo, u.tipo
    into v_lado, v_ubic_id, v_ubic_cod, v_ubic_tip
    from public.rep_loncheras l
    join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where l.id = p_lonchera_id;
  if not found then
    raise exception 'LONCHERA_NO_EXISTE|La lonchera destino no existe';
  end if;

  -- ¿El artículo ya está en esta lonchera? (suma cantidad)
  select exists (
    select 1 from public.rep_stock
    where lonchera_id = p_lonchera_id and articulo_id = p_articulo_id
  ) into v_existe;

  -- Capacidad: máx. 15 artículos DISTINTOS por lonchera
  if not v_existe then
    select count(*) >= 15 into v_llena
      from public.rep_stock where lonchera_id = p_lonchera_id;
    if v_llena then
      raise exception 'LONCHERA_LLENA|La lonchera % ya tiene 15 artículos distintos', v_ubic_cod;
    end if;
  end if;

  -- Regla "un artículo vive en una sola lonchera": aviso (no bloquea)
  select jsonb_build_object('lado', l.lado, 'ubicacion', u.codigo)
    into v_en_otra
    from public.rep_stock s
    join public.rep_loncheras l on l.id = s.lonchera_id
    join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where s.articulo_id = p_articulo_id and s.lonchera_id <> p_lonchera_id
    limit 1;

  insert into public.rep_stock (lonchera_id, articulo_id, cantidad)
  values (p_lonchera_id, p_articulo_id, p_cantidad)
  on conflict (lonchera_id, articulo_id)
  do update set cantidad = public.rep_stock.cantidad + excluded.cantidad,
                updated_at = now();

  insert into public.rep_movimientos (
    tipo, articulo_id, codigo, descripcion, und, cantidad,
    destino_ubicacion_id, destino_lado, referencia, usuario_id, usuario_nombre
  ) values (
    'ingreso', p_articulo_id, v_art.codigo, v_art.descripcion, v_art.und, p_cantidad,
    v_ubic_id, v_lado, p_referencia, v_user,
    coalesce((select nombre from public.profiles where id = v_user), '')
  )
  returning id into v_mov_id;

  return jsonb_build_object(
    'ok', true,
    'movimiento_id', v_mov_id,
    'ubicacion', v_ubic_cod,
    'lado', v_lado,
    'en_otra_lonchera', v_en_otra
  );
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 10) RLS — políticas gateadas por el cuadro de permisos
-- ────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'rep_articulos', 'rep_ubicaciones', 'rep_loncheras', 'rep_stock',
    'rep_ral', 'rep_ral_detalle', 'rep_movimientos'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- rep_articulos
drop policy if exists "rep_articulos_select" on public.rep_articulos;
drop policy if exists "rep_articulos_insert" on public.rep_articulos;
drop policy if exists "rep_articulos_update" on public.rep_articulos;
drop policy if exists "rep_articulos_delete" on public.rep_articulos;
create policy "rep_articulos_select" on public.rep_articulos
  for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.ver'));
create policy "rep_articulos_insert" on public.rep_articulos
  for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'));
create policy "rep_articulos_update" on public.rep_articulos
  for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'));
create policy "rep_articulos_delete" on public.rep_articulos
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.eliminar'));

-- rep_ubicaciones
drop policy if exists "rep_ubicaciones_select" on public.rep_ubicaciones;
drop policy if exists "rep_ubicaciones_insert" on public.rep_ubicaciones;
drop policy if exists "rep_ubicaciones_update" on public.rep_ubicaciones;
drop policy if exists "rep_ubicaciones_delete" on public.rep_ubicaciones;
create policy "rep_ubicaciones_select" on public.rep_ubicaciones
  for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.ver'));
create policy "rep_ubicaciones_insert" on public.rep_ubicaciones
  for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'));
create policy "rep_ubicaciones_update" on public.rep_ubicaciones
  for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'));
create policy "rep_ubicaciones_delete" on public.rep_ubicaciones
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.eliminar'));

-- rep_loncheras (solo lectura directa: las crea el trigger SECURITY DEFINER)
drop policy if exists "rep_loncheras_select" on public.rep_loncheras;
create policy "rep_loncheras_select" on public.rep_loncheras
  for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.ver'));

-- rep_stock (UPDATE con crear: la recepción hace upsert operativo)
drop policy if exists "rep_stock_select" on public.rep_stock;
drop policy if exists "rep_stock_insert" on public.rep_stock;
drop policy if exists "rep_stock_update" on public.rep_stock;
drop policy if exists "rep_stock_delete" on public.rep_stock;
create policy "rep_stock_select" on public.rep_stock
  for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.ver'));
create policy "rep_stock_insert" on public.rep_stock
  for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'repuestos.crear'));
create policy "rep_stock_update" on public.rep_stock
  for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.crear'))
  with check (public.tiene_permiso(auth.uid(), 'repuestos.crear'));
create policy "rep_stock_delete" on public.rep_stock
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.eliminar'));

-- rep_ral
drop policy if exists "rep_ral_select" on public.rep_ral;
drop policy if exists "rep_ral_insert" on public.rep_ral;
drop policy if exists "rep_ral_update" on public.rep_ral;
drop policy if exists "rep_ral_delete" on public.rep_ral;
create policy "rep_ral_select" on public.rep_ral
  for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.ver'));
create policy "rep_ral_insert" on public.rep_ral
  for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'repuestos.crear'));
create policy "rep_ral_update" on public.rep_ral
  for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'));
create policy "rep_ral_delete" on public.rep_ral
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.eliminar'));

-- rep_ral_detalle
drop policy if exists "rep_ral_detalle_select" on public.rep_ral_detalle;
drop policy if exists "rep_ral_detalle_insert" on public.rep_ral_detalle;
drop policy if exists "rep_ral_detalle_update" on public.rep_ral_detalle;
drop policy if exists "rep_ral_detalle_delete" on public.rep_ral_detalle;
create policy "rep_ral_detalle_select" on public.rep_ral_detalle
  for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.ver'));
create policy "rep_ral_detalle_insert" on public.rep_ral_detalle
  for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'repuestos.crear'));
create policy "rep_ral_detalle_update" on public.rep_ral_detalle
  for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'));
create policy "rep_ral_detalle_delete" on public.rep_ral_detalle
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.eliminar'));

-- rep_movimientos
drop policy if exists "rep_movimientos_select" on public.rep_movimientos;
drop policy if exists "rep_movimientos_insert" on public.rep_movimientos;
drop policy if exists "rep_movimientos_update" on public.rep_movimientos;
drop policy if exists "rep_movimientos_delete" on public.rep_movimientos;
create policy "rep_movimientos_select" on public.rep_movimientos
  for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.ver'));
create policy "rep_movimientos_insert" on public.rep_movimientos
  for insert to authenticated
  with check (public.tiene_permiso(auth.uid(), 'repuestos.crear'));
create policy "rep_movimientos_update" on public.rep_movimientos
  for update to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'))
  with check (public.tiene_permiso(auth.uid(), 'repuestos.gestionar'));
create policy "rep_movimientos_delete" on public.rep_movimientos
  for delete to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.eliminar'));

-- ────────────────────────────────────────────────────────────────────
-- 11) CUADRO DE PERMISOS — 4 permisos nuevos de Repuestos
--     (ampliación de permiso_defecto_rol + catálogo de
--      establecer_permiso_usuario; comportamiento previo intacto)
-- ────────────────────────────────────────────────────────────────────
create or replace function public.permiso_defecto_rol(p_rol text, p_permiso text)
returns boolean
language sql
stable
set search_path = public
as $$
  select case
    -- VER: todos los roles (comportamiento actual de las políticas SELECT)
    when p_permiso in ('racks.ver', 'piso.ver', 'recepcion.ver', 'atencion.ver',
                       'transito.ver', 'catalogo.ver', 'usuarios.ver', 'repuestos.ver')
      then true
    -- CREAR: todos los roles (comportamiento actual de las políticas INSERT)
    when p_permiso in ('movimientos.crear', 'piso_movimientos.crear', 'recepcion.crear',
                       'atencion.crear', 'transito.crear', 'repuestos.crear')
      then true
    -- EDITAR de recepción/atención: todos los roles (hoy así en BD y UI)
    when p_permiso in ('recepcion.editar', 'atencion.editar')
      then true
    -- Catálogo: supervisores+ (la UI ya ocultaba la edición al resto)
    when p_permiso in ('catalogo.crear', 'catalogo.editar', 'catalogo.eliminar')
      then p_rol in ('supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones')
    -- Repuestos: gestión de layout/catálogo y eliminaciones: supervisores+
    when p_permiso in ('repuestos.gestionar', 'repuestos.eliminar')
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
    'transito.ver', 'catalogo.ver', 'usuarios.ver', 'repuestos.ver',
    -- Crear
    'movimientos.crear', 'piso_movimientos.crear', 'recepcion.crear',
    'atencion.crear', 'transito.crear', 'catalogo.crear', 'descarga.subir',
    'repuestos.crear',
    -- Editar
    'recepcion.editar', 'atencion.editar', 'lote.editar',
    'sectores.gestionar', 'catalogo.editar', 'usuarios.gestionar_roles',
    'repuestos.gestionar',
    -- Eliminar
    'movimientos.eliminar', 'piso_movimientos.eliminar', 'recepcion.eliminar',
    'atencion.eliminar', 'catalogo.eliminar', 'usuarios.eliminar',
    'repuestos.eliminar',
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

-- ═══════════════════════════════════════════════════════════════════
-- FIN — Migración 100% aditiva. Verificación post-aplicación:
--   select tablename from pg_tables where schemaname='public' and tablename like 'rep\\_%';
--   select count(*) from pg_policies where tablename like 'rep\\_%';
-- ═══════════════════════════════════════════════════════════════════
