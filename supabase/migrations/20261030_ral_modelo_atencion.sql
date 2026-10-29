-- RACKLY · 2026-10-30 — Modelo de ATENCIÓN para RAL (espejo del modelo RQ).
--
-- Qué pidió el usuario (módulo Atención): «la atención de RAL debe ser el
-- mismo modelo que para la atención de RQ … y todo debe aparecer en una sola
-- lista». Hoy el RAL es un documento de solo lectura: sin estado y sin
-- cantidad atendida por material. Esta migración añade (SOLO aditivo, 0 filas
-- en producción al aplicarse) el mismo modelo de atención de la RQ:
--
--   · rals.estado           → Pendiente | En proceso | Atendido (regla canónica
--                             v9 Task 26: Atendido = nada pendiente · En
--                             proceso = hay algo atendido · Pendiente = nada).
--   · ral_items.cantidad_atendida / usuario_atencion / atendido_en → mismas
--                             columnas que rq_atencion_items.
--   · RPC ral_atender_item  → espejo literal de rq_atender_item (v8): guard de
--                             rol + incremento ATÓMICO + recálculo de estado.
--                             SIN tomas/ledger: el RAL no tiene modelo
--                             lote/posición (son materiales generales).
--   · RPC ral_revertir_item → espejo literal de rq_revertir_item (v8).
--   · RLS UPDATE en rals    → rq_atenciones SÍ tenía rq_update_auth pero rals
--                             NO tenía política UPDATE: la RPC (invoker,
--                             authenticated) no podría recalcular el estado.
--                             Espejo exacto de rq_update_auth.
--
-- ral_crear_completa NO se toca: los inserts sin las columnas nuevas caen a
-- sus defaults (estado='Pendiente', cantidad_atendida=0).

-- ── 1) Columnas nuevas ─────────────────────────────────────────────────────
alter table public.rals
  add column if not exists estado text not null default 'Pendiente';

alter table public.ral_items
  add column if not exists cantidad_atendida numeric not null default 0,
  add column if not exists usuario_atencion text not null default '',
  add column if not exists atendido_en timestamptz;

-- Índice para el recálculo de estado por encabezado (mismo patrón que la RQ).
create index if not exists idx_ral_items_ral_id on public.ral_items (ral_id);

-- ── 2) RLS UPDATE en rals (espejo EXACTO de rq_update_auth: using(true)
--       with check(true)). NOTA E2E 2026-10-30: crearla solo con with_check
--       deja qual=NULL y el UPDATE afecta 0 filas (silencioso) — rq_update_auth
--       tiene USING explícito y funciona; se replica tal cual. La app limita
--       edición a supervisores en la UI; el estado lo recalculan las RPC) ────
drop policy if exists rals_update_auth on public.rals;
create policy rals_update_auth on public.rals
  for update to authenticated
  using (true)
  with check (true);

-- ── 3) RPC ral_atender_item (espejo rq_atender_item v8/v9) ─────────────────
create or replace function public.ral_atender_item(p_item_id uuid, p_cantidad numeric, p_usuario text)
returns json
language plpgsql
as $function$
declare
  v_item ral_items%ROWTYPE;
  v_pendientes integer;
  v_alguno boolean;
begin
  -- Guard de rol, consistente con rq_atender_item v8.
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden atender materiales';
  END IF;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a atender debe ser mayor que cero';
  end if;

  -- Incremento ATÓMICO en un solo UPDATE (sobreatención permitida: puede ser
  -- más, nunca menos — igual que la RQ v2).
  update ral_items set
    cantidad_atendida = cantidad_atendida + p_cantidad,
    usuario_atencion = coalesce(nullif(p_usuario, ''), usuario_atencion),
    atendido_en = case when cantidad_atendida + p_cantidad >= cantidad then now() else null end
  where id = p_item_id
  returning * into v_item;

  if not found then
    raise exception 'Artículo no encontrado (puede haber sido eliminado)';
  end if;

  -- Regla canónica de estado (v9 Task 26, unificada con revertir).
  select count(*) into v_pendientes
    from ral_items
    where ral_id = v_item.ral_id and cantidad_atendida < cantidad;
  select coalesce(exists(
    select 1 from ral_items where ral_id = v_item.ral_id and cantidad_atendida > 0
  ), false) into v_alguno;

  update rals set
    estado = case
      when v_pendientes = 0 then 'Atendido'
      when v_alguno then 'En proceso'
      else 'Pendiente' end
  where id = v_item.ral_id;

  return to_json(v_item);
end $function$;

-- ── 4) RPC ral_revertir_item (espejo rq_revertir_item v8/v9) ───────────────
create or replace function public.ral_revertir_item(p_item_id uuid, p_cantidad numeric)
returns json
language plpgsql
as $function$
declare
  v_item ral_items%ROWTYPE;
  v_pendientes integer;
  v_alguno boolean;
begin
  -- Guard de rol + decremento ATÓMICO (nunca por debajo de 0).
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden revertir atenciones';
  END IF;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a revertir debe ser mayor que cero';
  end if;

  update ral_items set
    cantidad_atendida = greatest(cantidad_atendida - p_cantidad, 0),
    atendido_en = case when greatest(cantidad_atendida - p_cantidad, 0) >= cantidad then atendido_en else null end
  where id = p_item_id
  returning * into v_item;

  if not found then
    raise exception 'Artículo no encontrado';
  end if;

  -- Regla canónica de estado (v9 Task 26).
  select count(*) into v_pendientes
    from ral_items
    where ral_id = v_item.ral_id and cantidad_atendida < cantidad;
  select coalesce(exists(
    select 1 from ral_items where ral_id = v_item.ral_id and cantidad_atendida > 0
  ), false) into v_alguno;

  update rals set
    estado = case
      when v_pendientes = 0 then 'Atendido'
      when v_alguno then 'En proceso'
      else 'Pendiente' end
  where id = v_item.ral_id;

  return to_json(v_item);
end $function$;
