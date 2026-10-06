-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · Migración 20261007 — Módulos Recepción y Atención
--
-- Crea las 2 tablas nuevas de los módulos independientes:
--   recepcion_registros  → registro de recepción de mercadería/documentos
--   atencion_registros   → tickets de atención y soporte interno
--
-- REGLAS DE SEGURIDAD (consistente con hardening 2026):
--   · RLS habilitado en ambas tablas, políticas SOLO para `authenticated`.
--   · Privilegios revocados a `anon` (defensa en profundidad).
--   · La app escribe vía service_role (dataClient), que ignora RLS.
--
-- NOTA: esta migración es 100% ADITIVA. No toca ninguna tabla existente
-- (movimientos, piso_*, profiles, catalogo, user_roles).
-- ═══════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1) RECEPCIÓN
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.recepcion_registros (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  fecha             date        not null default current_date,
  tipo_documento    text        not null default 'Guia',
  numero_documento  text        not null default '',
  proveedor         text        not null default '',
  codigo            text        not null default '',
  descripcion       text        not null default '',
  cantidad          numeric     not null default 0,
  estado            text        not null default 'Pendiente',
  observaciones     text,
  usuario_id        uuid,
  usuario_nombre    text        not null default '',
  usuario_correo    text        not null default ''
);

comment on table public.recepcion_registros is
  'Modulo Recepcion: registros de recepcion de mercaderia/documentos (independiente de kardex).';

alter table public.recepcion_registros enable row level security;

drop policy if exists "recepcion_select_auth"   on public.recepcion_registros;
drop policy if exists "recepcion_insert_auth"   on public.recepcion_registros;
drop policy if exists "recepcion_update_auth"   on public.recepcion_registros;
drop policy if exists "recepcion_delete_auth"   on public.recepcion_registros;

create policy "recepcion_select_auth" on public.recepcion_registros
  for select to authenticated using (true);
create policy "recepcion_insert_auth" on public.recepcion_registros
  for insert to authenticated with check (true);
create policy "recepcion_update_auth" on public.recepcion_registros
  for update to authenticated using (true) with check (true);
create policy "recepcion_delete_auth" on public.recepcion_registros
  for delete to authenticated using (true);

revoke all on public.recepcion_registros from anon;

create index if not exists idx_recepcion_fecha_desc
  on public.recepcion_registros (fecha desc, created_at desc);
create index if not exists idx_recepcion_usuario_id
  on public.recepcion_registros (usuario_id);
create index if not exists idx_recepcion_codigo
  on public.recepcion_registros (codigo);

-- ────────────────────────────────────────────────────────────────────
-- 2) ATENCIÓN
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.atencion_registros (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  fecha          date        not null default current_date,
  solicitante    text        not null default '',
  area           text        not null default '',
  tipo           text        not null default 'Consulta',
  asunto         text        not null default '',
  detalle        text,
  estado         text        not null default 'Pendiente',
  atendido_en    timestamptz,
  usuario_id     uuid,
  usuario_nombre text        not null default '',
  usuario_correo text        not null default ''
);

comment on table public.atencion_registros is
  'Modulo Atencion: tickets de atencion/soporte interno (independiente de kardex).';

alter table public.atencion_registros enable row level security;

drop policy if exists "atencion_select_auth"   on public.atencion_registros;
drop policy if exists "atencion_insert_auth"   on public.atencion_registros;
drop policy if exists "atencion_update_auth"   on public.atencion_registros;
drop policy if exists "atencion_delete_auth"   on public.atencion_registros;

create policy "atencion_select_auth" on public.atencion_registros
  for select to authenticated using (true);
create policy "atencion_insert_auth" on public.atencion_registros
  for insert to authenticated with check (true);
create policy "atencion_update_auth" on public.atencion_registros
  for update to authenticated using (true) with check (true);
create policy "atencion_delete_auth" on public.atencion_registros
  for delete to authenticated using (true);

revoke all on public.atencion_registros from anon;

create index if not exists idx_atencion_fecha_desc
  on public.atencion_registros (fecha desc, created_at desc);
create index if not exists idx_atencion_usuario_id
  on public.atencion_registros (usuario_id);
create index if not exists idx_atencion_estado
  on public.atencion_registros (estado);
