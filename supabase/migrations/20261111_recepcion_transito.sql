-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY · REPUESTOS — Recepción SIN destino + Tránsito que UBICA (2026-11-11)
--
-- Cambio de flujo (pedido del usuario, paridad con Almacén Insumos):
--   ANTES: Recepción elegía la lonchera destino y rep_registrar_ingreso
--          escribía stock + kardex en el mismo clic.
--   AHORA: Recepción SOLO registra el DOCUMENTO (guía/OC/DAM/proveedor +
--          líneas código/cantidad con descripción y UM jaladas del catálogo).
--          Los artículos quedan «en tránsito»; el módulo TRÁNSITO los lista
--          y es ahí donde se decide a qué lonchera van — al ubicar se
--          escribe el stock y el kardex de ingreso (el lugar físico real).
--
-- Diseño (metodología 4-5: mínima superficie de conflicto, todo aditivo):
--   · ¿Por qué capa de DOCUMENTO y no una ubicación virtual «TRÁNSITO»?
--     Una ubicación virtual pondría filas de rep_stock en una lonchera
--     fantasma y OBLIGARÍA a filtrar TRÁNSITO en mapa, kardex, ocupación,
--     Atención y búsqueda — superficie de error enorme. Con la capa de
--     documento, rep_stock y rep_movimientos conservan SU SEMÁNTICA
--     EXACTA (solo escriben cuando la mercadería entra a una lonchera
--     real): mapa/Atención/Kardex/Ocupación no cambian NI UNA LÍNEA.
--   · El kardex sigue siendo HONESTO: el 'ingreso' se registra cuando la
--     pieza entra físicamente a su lonchera (mismo momento en que Insumos
--     escribe el ingreso: al enviar desde Tránsito).
--   · Idempotencia tipo Insumos (uuid_sync del CLIENTE + índice único):
--     un reintento de red o un doble clic devuelve el documento ya
--     guardado en vez de duplicar líneas.
--   · Seguridad: RLS solo-lectura directa (repuestos.ver); toda
--     escritura pasa por las 2 RPC SECURITY DEFINER con guard
--     repuestos.crear (mismo cuadro de permisos que rep_registrar_ingreso).
--   · El kardex previo (guías con destino directo) sigue intacto y
--     consultable; las 2 RPC nuevas NO tocan la RPC rep_registrar_ingreso.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Cabecera del documento de recepción ─────────────────────────────────
create table if not exists public.rep_recepciones (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  guia           text not null default '',
  oc             text not null default '',
  dam            text not null default '',
  usuario_id     uuid references public.profiles (id),
  usuario_nombre text not null default '',
  -- Idempotencia (Insumos): uuid generado por el CLIENTE por formulario.
  -- Reintento del MISMO guardado choca con este índice y no duplica.
  uuid_sync      text not null
);

comment on table public.rep_recepciones is
  'REPUESTOS · cabecera del documento de recepción (guía/OC/DAM). Solo registro: el stock y el kardex se escriben al UBICAR en Tránsito.';

create unique index if not exists uq_rep_recepciones_uuid_sync
  on public.rep_recepciones (uuid_sync);
create index if not exists idx_rep_recepciones_guia
  on public.rep_recepciones (guia);
create index if not exists idx_rep_recepciones_created
  on public.rep_recepciones (created_at desc);

-- ── 2) Líneas del documento (1 por artículo de la guía) ────────────────────
create table if not exists public.rep_recepcion_lineas (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  recepcion_id  uuid not null references public.rep_recepciones (id) on delete cascade,
  articulo_id   uuid not null references public.rep_articulos (id),
  -- Copia del catálogo AL MOMENTO de recibir (el rótulo debe decir lo que
  -- dijo la recepción aunque el catálogo cambie después).
  codigo        text not null default '',
  descripcion   text not null default '',
  und           text not null default '',
  cantidad      numeric not null check (cantidad > 0),
  proveedor     text not null default '',
  -- en_transito = esperando ubicación en el módulo Tránsito;
  -- ubicado      = ya tiene lonchera, stock y kardex (movimiento_id).
  estado        text not null default 'en_transito'
                  check (estado in ('en_transito', 'ubicado')),
  lonchera_id   uuid references public.rep_loncheras (id),
  ubicacion_id  uuid references public.rep_ubicaciones (id),
  movimiento_id uuid references public.rep_movimientos (id),
  uuid_sync     text not null
);

comment on table public.rep_recepcion_lineas is
  'REPUESTOS · líneas de la recepción: código/descripción/UM/copiadosp del catálogo + cantidad + proveedor. estado en_transito→ubicado (Tránsito).';

create unique index if not exists uq_rep_recepcion_lineas_uuid_sync
  on public.rep_recepcion_lineas (uuid_sync);
create index if not exists idx_rep_recepcion_lineas_recepcion
  on public.rep_recepcion_lineas (recepcion_id);
-- El índice operativo de Tránsito: SOLO las pendientes.
create index if not exists idx_rep_recepcion_lineas_pendientes
  on public.rep_recepcion_lineas (recepcion_id, created_at)
  where estado = 'en_transito';
create index if not exists idx_rep_recepcion_lineas_codigo
  on public.rep_recepcion_lineas (codigo);

-- ── 3) RLS: lectura directa (repuestos.ver); escritura SOLO por RPC ────────
alter table public.rep_recepciones      enable row level security;
alter table public.rep_recepcion_lineas enable row level security;
revoke all on public.rep_recepciones      from anon;
revoke all on public.rep_recepcion_lineas from anon;

drop policy if exists "rep_recepciones_select" on public.rep_recepciones;
create policy "rep_recepciones_select" on public.rep_recepciones
  for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.ver'));

drop policy if exists "rep_recepcion_lineas_select" on public.rep_recepcion_lineas;
create policy "rep_recepcion_lineas_select" on public.rep_recepcion_lineas
  for select to authenticated
  using (public.tiene_permiso(auth.uid(), 'repuestos.ver'));

-- Sin políticas INSERT/UPDATE/DELETE: las escrituras van SOLO por las RPC
-- SECURITY DEFINER (mismo patrón que rep_loncheras). Ni un INSERT directo.

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 1 · rep_registrar_recepcion — guarda el DOCUMENTO (sin stock ni kardex)
-- ═══════════════════════════════════════════════════════════════════════════
-- p_lineas: jsonb array [{articulo_id, cantidad, proveedor}, ...]
--   · codigo/descripcion/und se llenan DESDE EL CATÁLOGO (fuente de verdad);
--     el cliente ya los mostró, pero la BD no confía en el eco del cliente.
-- Devuelve {ok, recepcion_id, linea_ids:[...]} — o el documento previo si
-- uuid_sync ya existía (duplicado honesto, cero filas nuevas).
create or replace function public.rep_registrar_recepcion(
  p_guia        text,
  p_oc          text,
  p_dam         text,
  p_lineas      jsonb,
  p_uuid_sync   text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user      uuid := auth.uid();
  v_guia      text := coalesce(trim(p_guia), '');
  v_oc        text := coalesce(trim(p_oc), '');
  v_dam       text := coalesce(trim(p_dam), '');
  v_rec_id    uuid;
  v_linea_id  uuid;
  v_linea     jsonb;
  v_art       public.rep_articulos;
  v_linea_ids jsonb := '[]'::jsonb;
  v_prov      text;
  i           int;
begin
  -- Guard de permiso (mismo cuadro que rep_registrar_ingreso)
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.crear') then
      raise exception 'NO_AUTORIZADO|No tienes permiso para registrar recepciones en Repuestos';
    end if;
  end if;

  if v_guia = '' then
    raise exception 'GUIA_REQUERIDA|Ingresa el N° de Guía';
  end if;
  if p_uuid_sync is null or trim(p_uuid_sync) = '' then
    raise exception 'UUID_REQUERIDO|Falta el identificador único de la recepción';
  end if;
  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'LINEAS_REQUERIDAS|Agrega al menos un artículo a la guía';
  end if;

  -- Serializa reintentos del MISMO lote (dos pestañas, doble clic, red lenta)
  perform pg_advisory_xact_lock(hashtextextended('rep-rec-' || trim(p_uuid_sync), 6211));

  -- IDEMPOTENCIA: mismo uuid_sync → devuelve el documento ya guardado
  select r.id into v_rec_id
    from public.rep_recepciones r
    where r.uuid_sync = trim(p_uuid_sync);
  if found then
    -- MISMO orden que p_lineas: el sufijo numérico de uuid_sync ('-1','-2'…)
    -- es el índice de línea original — así linea_ids[i] SIEMPRE corresponde
    -- a la línea i+1 (un mapeo por posición seguro para los rótulos).
    select coalesce(jsonb_agg(l.id order by
               (regexp_replace(l.uuid_sync, '^.*-', ''))::int), '[]'::jsonb)
      into v_linea_ids
      from public.rep_recepcion_lineas l
      where l.recepcion_id = v_rec_id;
    return jsonb_build_object('ok', true, 'duplicado', true,
                              'recepcion_id', v_rec_id, 'linea_ids', v_linea_ids);
  end if;

  -- Valida TODAS las líneas ANTES de insertar nada (todo-o-nada)
  for i in 0 .. jsonb_array_length(p_lineas) - 1 loop
    v_linea := p_lineas -> i;
    if v_linea ->> 'articulo_id' is null then
      raise exception 'ARTICULO_REQUERIDO|La línea % no tiene artículo', i + 1;
    end if;
    if coalesce((v_linea ->> 'cantidad')::numeric, 0) <= 0 then
      raise exception 'CANTIDAD_INVALIDA|La cantidad de la línea % debe ser mayor que cero', i + 1;
    end if;
    select * into v_art from public.rep_articulos where id = (v_linea ->> 'articulo_id')::uuid;
    if not found then
      raise exception 'ARTICULO_NO_EXISTE|El artículo de la línea % no existe en el catálogo', i + 1;
    end if;
    if not v_art.activo then
      raise exception 'ARTICULO_INACTIVO|El artículo % está inactivo en el catálogo', v_art.codigo;
    end if;
  end loop;

  insert into public.rep_recepciones (guia, oc, dam, usuario_id, usuario_nombre, uuid_sync)
  values (v_guia, v_oc, v_dam, v_user,
          coalesce((select nombre from public.profiles where id = v_user), ''),
          trim(p_uuid_sync))
  returning id into v_rec_id;

  for i in 0 .. jsonb_array_length(p_lineas) - 1 loop
    v_linea := p_lineas -> i;
    select * into v_art from public.rep_articulos where id = (v_linea ->> 'articulo_id')::uuid;
    v_prov := coalesce(trim(v_linea ->> 'proveedor'), '');
    insert into public.rep_recepcion_lineas
      (recepcion_id, articulo_id, codigo, descripcion, und, cantidad, proveedor, uuid_sync)
    values
      (v_rec_id, v_art.id, v_art.codigo, v_art.descripcion, v_art.und,
       (v_linea ->> 'cantidad')::numeric, v_prov,
       trim(p_uuid_sync) || '-' || (i + 1)::text)
    returning id into v_linea_id;
    v_linea_ids := v_linea_ids || jsonb_build_array(v_linea_id);
  end loop;

  return jsonb_build_object('ok', true, 'duplicado', false,
                            'recepcion_id', v_rec_id, 'linea_ids', v_linea_ids);
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 2 · rep_ubicar_desde_transito — UBICA una línea (stock + kardex + marca)
-- ═══════════════════════════════════════════════════════════════════════════
-- Es el «envío» de Tránsito (Insumos) versionado a Repuestos: toma UNA línea
-- en_transito, la manda a la lonchera elegida y EN LA MISMA transacción:
--   · valida capacidad 15 artículos distintos (regla del almacén),
--   · hace upsert de rep_stock (suma cantidad),
--   · escribe el kardex 'ingreso' con el DOCUMENTO (guía/OC/DAM/proveedor),
--   · marca la línea como ubicada (estado, lonchera, movimiento).
-- Reglas EXACTAS de rep_registrar_ingreso (capacidad/upsert/aviso otra
-- lonchera) — fuente de verdad de la física del almacén, sin cambios.
create or replace function public.rep_ubicar_desde_transito(
  p_linea_id   uuid,
  p_lonchera_id uuid
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user     uuid := auth.uid();
  v_linea    public.rep_recepcion_lineas;
  v_rec      public.rep_recepciones;
  v_art      public.rep_articulos;
  v_lado     text;
  v_ubic_id  uuid;
  v_ubic_cod text;
  v_existe   boolean;
  v_llena    boolean;
  v_en_otra  jsonb;
  v_mov_id   uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.crear') then
      raise exception 'NO_AUTORIZADO|No tienes permiso para ubicar artículos en Repuestos';
    end if;
  end if;

  if p_linea_id is null or p_lonchera_id is null then
    raise exception 'DATO_REQUERIDO|Falta la línea o la lonchera destino';
  end if;

  -- Lock de la línea: dos ubicaciones simultáneas de la MISMA línea se
  -- serializan y la segunda ve estado 'ubicado' (nunca duplica stock).
  select * into v_linea
    from public.rep_recepcion_lineas
    where id = p_linea_id
    for update;
  if not found then
    raise exception 'LINEA_NO_EXISTE|La línea de recepción ya no existe';
  end if;
  if v_linea.estado = 'ubicado' then
    raise exception 'LINEA_YA_UBICADA|% ya fue ubicado a su lonchera', v_linea.codigo;
  end if;

  select * into v_art from public.rep_articulos where id = v_linea.articulo_id;
  if not found then
    raise exception 'ARTICULO_NO_EXISTE|El artículo no existe en el catálogo';
  end if;
  if not v_art.activo then
    raise exception 'ARTICULO_INACTIVO|El artículo está inactivo en el catálogo';
  end if;

  select l.lado, u.id, u.codigo
    into v_lado, v_ubic_id, v_ubic_cod
    from public.rep_loncheras l
    join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where l.id = p_lonchera_id;
  if not found then
    raise exception 'LONCHERA_NO_EXISTE|La lonchera destino no existe';
  end if;

  -- ¿Ya está en esta lonchera? (suma cantidad) — regla del ingreso clásico
  select exists (
    select 1 from public.rep_stock
    where lonchera_id = p_lonchera_id and articulo_id = v_linea.articulo_id
  ) into v_existe;

  -- Capacidad: máx. 15 artículos DISTINTOS por lonchera
  if not v_existe then
    select count(*) >= 15 into v_llena
      from public.rep_stock where lonchera_id = p_lonchera_id;
    if v_llena then
      raise exception 'LONCHERA_LLENA|La lonchera % ya tiene 15 artículos distintos', v_ubic_cod;
    end if;
  end if;

  -- Aviso (no bloquea): el artículo ya vive en OTRA lonchera
  select jsonb_build_object('lado', l.lado, 'ubicacion', u.codigo)
    into v_en_otra
    from public.rep_stock s
    join public.rep_loncheras l on l.id = s.lonchera_id
    join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where s.articulo_id = v_linea.articulo_id and s.lonchera_id <> p_lonchera_id
    limit 1;

  select * into v_rec from public.rep_recepciones where id = v_linea.recepcion_id;

  -- Stock + kardex EN LA MISMA transacción que la marca de la línea:
  -- si algo falla, NADA queda a medias (ni stock fantasma ni línea ubicada).
  insert into public.rep_stock (lonchera_id, articulo_id, cantidad)
  values (p_lonchera_id, v_linea.articulo_id, v_linea.cantidad)
  on conflict (lonchera_id, articulo_id)
  do update set cantidad = public.rep_stock.cantidad + excluded.cantidad,
                updated_at = now();

  insert into public.rep_movimientos (
    tipo, articulo_id, codigo, descripcion, und, cantidad,
    destino_ubicacion_id, destino_lado, referencia, usuario_id, usuario_nombre,
    guia, oc, dam, proveedor
  ) values (
    'ingreso', v_linea.articulo_id, v_art.codigo, v_art.descripcion, v_art.und, v_linea.cantidad,
    v_ubic_id, v_lado, v_rec.guia, v_user,
    coalesce((select nombre from public.profiles where id = v_user), ''),
    v_rec.guia, v_rec.oc, v_rec.dam, v_linea.proveedor
  )
  returning id into v_mov_id;

  update public.rep_recepcion_lineas
    set estado = 'ubicado',
        lonchera_id = p_lonchera_id,
        ubicacion_id = v_ubic_id,
        movimiento_id = v_mov_id
    where id = v_linea.id;

  return jsonb_build_object(
    'ok', true,
    'movimiento_id', v_mov_id,
    'ubicacion', v_ubic_cod,
    'lado', v_lado,
    'en_otra_lonchera', v_en_otra
  );
end;
$function$;
