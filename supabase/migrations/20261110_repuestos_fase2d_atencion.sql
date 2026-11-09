-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · Migración 20261110d — REPUESTOS: Atención (RAL) + Tránsito
--
-- Operaciones ATÓMICAS del flujo de salida (incremento 2). Tocan varias
-- tablas por paso (stock + movimientos + RAL), así que van por RPC
-- SECURITY DEFINER con guard de permiso (patrón del kardex):
--
--   rep_pickear_linea    Atención: toma la cantidad del artículo de su
--                        lonchera y lo estaciona en pre-picking con el
--                        ral_id (Tránsito). Devuelve lo que había (aviso
--                        honesto si el stock no alcanzó — la BD jamás
--                        queda negativa).
--   rep_despachar_ral    Tránsito: SALIDA física del RAL completo —
--                        retira las filas en pre-picking, escribe los
--                        movimientos 'salida' y marca despachado.
--   rep_devolver_linea   Tránsito: una línea vuelve del pre-picking a su
--                        lonchera de origen (movimiento 'devolucion').
--   rep_anular_ral       Anula un RAL sin carga estacionada.
--
-- NOTA DE CAPACIDAD: las loncheras de PRE-PICKING están EXENTAS del tope
-- de 15 artículos: es estacionamiento de horas para la salida del día y
-- se vacía en cada despacho (el tope rige para el almacenaje).
--
-- AJUSTE DE POLÍTICA (rep_ral_detalle.delete): pasar de 'repuestos.eliminar'
-- a 'repuestos.crear' SOLO mientras el RAL esté 'registrado' — el operario
-- corrige SU RAL en curso; un RAL despachado/anulado es documento intocable.
-- ═══════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1) rep_pickear_linea — picking a pre-picking
-- ────────────────────────────────────────────────────────────────────
create or replace function public.rep_pickear_linea(
  p_detalle_id            uuid,
  p_prepicking_lonchera_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_det     public.rep_ral_detalle;
  v_ral     public.rep_ral;
  v_art     public.rep_articulos;
  v_lon_id  uuid;
  v_ubi_id  uuid;
  v_ubi_cod text;
  v_restante numeric;
  v_tomado  numeric := 0;
  r         record;
  v_primera_lonchera uuid := null;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.crear') then
      raise exception 'NO_AUTORIZADO|No tienes permiso para operar el picking de Repuestos';
    end if;
  end if;

  select * into v_det from public.rep_ral_detalle where id = p_detalle_id;
  if not found then
    raise exception 'LINEA_NO_EXISTE|La línea del RAL no existe';
  end if;

  select * into v_ral from public.rep_ral where id = v_det.ral_id;
  if v_ral.estado <> 'registrado' then
    raise exception 'RAL_NO_REGISTRADO|El RAL % ya no está registrado (estado: %)', v_ral.numero, v_ral.estado;
  end if;

  -- ¿Ya está estacionada esta línea? (una fila en pre-picking con el ral_id)
  if exists (
    select 1 from public.rep_stock
    where articulo_id = v_det.articulo_id and ral_id = v_det.ral_id
  ) then
    raise exception 'LINEA_YA_PICKEADA|La línea ya está en Tránsito (picking ya registrado)';
  end if;

  select * into v_art from public.rep_articulos where id = v_det.articulo_id;
  if not found then
    raise exception 'ARTICULO_NO_EXISTE|El artículo no existe en el catálogo';
  end if;

  -- Lonchera de pre-picking: la pedida o la primera disponible (orden físico)
  if p_prepicking_lonchera_id is not null then
    select l.id, u.id, u.codigo into v_lon_id, v_ubi_id, v_ubi_cod
      from public.rep_loncheras l
      join public.rep_ubicaciones u on u.id = l.ubicacion_id
      where l.id = p_prepicking_lonchera_id and u.tipo = 'prepicking';
    if not found then
      raise exception 'PREPICKING_NO_VALIDA|La lonchera indicada no es de pre-picking';
    end if;
  else
    select l.id, u.id, u.codigo into v_lon_id, v_ubi_id, v_ubi_cod
      from public.rep_ubicaciones u
      join public.rep_loncheras l on l.ubicacion_id = u.id
      where u.tipo = 'prepicking' and u.activo
      order by u.piso, u.nivel, u.secuencia
      limit 1;
    if not found then
      raise exception 'PREPICKING_NO_EXISTE|No hay ninguna ubicación de pre-picking: créala en Ubicaciones';
    end if;
  end if;

  -- Descuenta del ALMACÉN (loncheras, sin ral_id): nunca negativo.
  -- Puede atravesar varias loncheras si el artículo tiene la excepción
  -- controlada de "vive en dos". Devuelve lo logrado para avisar faltante.
  v_restante := v_det.cantidad;
  for r in
    select * from public.rep_stock
    where articulo_id = v_det.articulo_id and ral_id is null
    order by updated_at asc
    for update
  loop
    exit when v_restante <= 0;
    if v_primera_lonchera is null then
      v_primera_lonchera := r.lonchera_id;
    end if;
    if r.cantidad > 0 then
      v_tomado := least(r.cantidad, v_restante);
      v_restante := v_restante - v_tomado;
      if r.cantidad - v_tomado <= 0 then
        delete from public.rep_stock where id = r.id;
      else
        update public.rep_stock set cantidad = cantidad - v_tomado, updated_at = now() where id = r.id;
      end if;
    end if;
  end loop;

  -- Estaciona en pre-picking con el ral_id (capacidad 15 NO aplica aquí)
  insert into public.rep_stock (lonchera_id, articulo_id, cantidad, ral_id)
  values (v_lon_id, v_det.articulo_id, v_det.cantidad, v_det.ral_id)
  on conflict (lonchera_id, articulo_id) do update
    set cantidad = excluded.cantidad, ral_id = excluded.ral_id, updated_at = now();

  -- Kardex: traslado lonchera → pre-picking
  insert into public.rep_movimientos (
    tipo, articulo_id, codigo, descripcion, und, cantidad,
    origen_ubicacion_id, origen_lado, destino_ubicacion_id, destino_lado,
    ral_id, referencia, usuario_id, usuario_nombre
  )
  select
    'traslado', v_art.id, v_art.codigo, v_art.descripcion, v_art.und, v_det.cantidad,
    origen.u_id, origen.lado, v_ubi_id, 'A',
    v_ral.id, 'RAL ' || v_ral.numero, v_user,
    coalesce((select nombre from public.profiles where id = v_user), '')
  from (
    select u.id as u_id, l.lado
    from public.rep_loncheras l join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where l.id = coalesce(v_primera_lonchera, v_lon_id)
  ) as origen;

  return jsonb_build_object(
    'ok', true,
    'prepicking', v_ubi_cod,
    'cantidad', v_det.cantidad,
    'tomado_de_almacen', v_tomado,
    'faltante', v_restante
  );
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 2) rep_despachar_ral — salida física del RAL completo
-- ────────────────────────────────────────────────────────────────────
create or replace function public.rep_despachar_ral(p_ral_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_ral   public.rep_ral;
  v_lineas integer := 0;
  v_cantidad numeric := 0;
  r       record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.crear') then
      raise exception 'NO_AUTORIZADO|No tienes permiso para despachar en Repuestos';
    end if;
  end if;

  select * into v_ral from public.rep_ral where id = p_ral_id;
  if not found then
    raise exception 'RAL_NO_EXISTE|El RAL no existe';
  end if;
  if v_ral.estado <> 'registrado' then
    raise exception 'RAL_ESTADO_INVALIDO|El RAL % ya está %', v_ral.numero, v_ral.estado;
  end if;

  for r in
    select s.*, u.id as ubi_id
    from public.rep_stock s
    join public.rep_loncheras l on l.id = s.lonchera_id
    join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where s.ral_id = p_ral_id
    for update
  loop
    insert into public.rep_movimientos (
      tipo, articulo_id, codigo, descripcion, und, cantidad,
      origen_ubicacion_id, origen_lado, ral_id, referencia, usuario_id, usuario_nombre
    )
    select
      'salida', r.articulo_id, a.codigo, a.descripcion, a.und, r.cantidad,
      r.ubi_id, l.lado, p_ral_id, 'RAL ' || v_ral.numero, v_user,
      coalesce((select nombre from public.profiles where id = v_user), '')
    from public.rep_articulos a, public.rep_loncheras l
    where a.id = r.articulo_id and l.id = r.lonchera_id;

    delete from public.rep_stock where id = r.id;
    v_lineas := v_lineas + 1;
    v_cantidad := v_cantidad + r.cantidad;
  end loop;

  if v_lineas = 0 then
    raise exception 'RAL_SIN_CARGA|El RAL % no tiene artículos en pre-picking: registra el picking en Atención', v_ral.numero;
  end if;

  update public.rep_ral set estado = 'despachado' where id = p_ral_id;

  return jsonb_build_object('ok', true, 'lineas', v_lineas, 'cantidad', v_cantidad);
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 3) rep_devolver_linea — de pre-picking de vuelta a la lonchera
-- ────────────────────────────────────────────────────────────────────
create or replace function public.rep_devolver_linea(p_detalle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_det    public.rep_ral_detalle;
  v_ral    public.rep_ral;
  v_fila   record;
  v_lon_id uuid;
  v_ubi_id uuid;
  v_lado   text;
  v_ubi_cod text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.crear') then
      raise exception 'NO_AUTORIZADO|No tienes permiso para devolver artículos en Repuestos';
    end if;
  end if;

  select * into v_det from public.rep_ral_detalle where id = p_detalle_id;
  if not found then
    raise exception 'LINEA_NO_EXISTE|La línea del RAL no existe';
  end if;

  select * into v_ral from public.rep_ral where id = v_det.ral_id;
  if v_ral.estado <> 'registrado' then
    raise exception 'RAL_NO_REGISTRADO|El RAL % ya no está registrado', v_ral.numero;
  end if;

  select s.*, l.lado into v_fila
  from public.rep_stock s
  join public.rep_loncheras l on l.id = s.lonchera_id
  where s.articulo_id = v_det.articulo_id and s.ral_id = v_det.ral_id
  for update;
  if not found then
    raise exception 'LINEA_NO_EN_TRANSITO|La línea no está en Tránsito (nada que devolver)';
  end if;

  -- Destino: la lonchera de ORIGEN del traslado del picking (kardex);
  -- respaldo: cualquier fila de almacén viva del artículo.
  select m.origen_ubicacion_id, m.origen_lado into v_ubi_id, v_lado
  from public.rep_movimientos m
  where m.articulo_id = v_det.articulo_id and m.ral_id = v_det.ral_id and m.tipo = 'traslado'
  order by m.created_at desc
  limit 1;

  if v_ubi_id is not null then
    select l.id, u.codigo into v_lon_id, v_ubi_cod
    from public.rep_loncheras l join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where l.ubicacion_id = v_ubi_id and l.lado = coalesce(v_lado, 'A')
    limit 1;
  end if;
  if v_lon_id is null then
    select s.lonchera_id, u.codigo into v_lon_id, v_ubi_cod
    from public.rep_stock s
    join public.rep_loncheras l on l.id = s.lonchera_id
    join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where s.articulo_id = v_det.articulo_id and s.ral_id is null
    limit 1;
  end if;
  if v_lon_id is null then
    raise exception 'SIN_LONCHERA_DESTINO|El artículo no tiene lonchera de origen: recíbelo por Recepción';
  end if;

  delete from public.rep_stock where id = v_fila.id;

  insert into public.rep_stock (lonchera_id, articulo_id, cantidad)
  values (v_lon_id, v_det.articulo_id, v_fila.cantidad)
  on conflict (lonchera_id, articulo_id) do update
    set cantidad = public.rep_stock.cantidad + excluded.cantidad, updated_at = now();

  insert into public.rep_movimientos (
    tipo, articulo_id, codigo, descripcion, und, cantidad,
    origen_ubicacion_id, origen_lado, destino_ubicacion_id, destino_lado,
    ral_id, referencia, usuario_id, usuario_nombre
  )
  select
    'devolucion', v_det.articulo_id, a.codigo, a.descripcion, a.und, v_fila.cantidad,
    origen.u_id, origen.lado, dest.u_id, dest.lado,
    v_ral.id, 'RAL ' || v_ral.numero, v_user,
    coalesce((select nombre from public.profiles where id = v_user), '')
  from public.rep_articulos a,
       lateral (select u.id as u_id, v_fila.lado from public.rep_ubicaciones u where u.id = (select ubicacion_id from public.rep_loncheras where id = v_fila.lonchera_id)) origen,
       lateral (select u.id as u_id, l.lado from public.rep_loncheras l join public.rep_ubicaciones u on u.id = l.ubicacion_id where l.id = v_lon_id) dest
  where a.id = v_det.articulo_id;

  return jsonb_build_object('ok', true, 'destino', v_ubi_cod);
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 4) rep_anular_ral — solo sin carga estacionada
-- ────────────────────────────────────────────────────────────────────
create or replace function public.rep_anular_ral(p_ral_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_ral  public.rep_ral;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.crear') then
      raise exception 'NO_AUTORIZADO|No tienes permiso para anular RALs en Repuestos';
    end if;
  end if;

  select * into v_ral from public.rep_ral where id = p_ral_id;
  if not found then
    raise exception 'RAL_NO_EXISTE|El RAL no existe';
  end if;
  if v_ral.estado <> 'registrado' then
    raise exception 'RAL_ESTADO_INVALIDO|Solo un RAL registrado puede anularse (está %)', v_ral.estado;
  end if;
  if exists (select 1 from public.rep_stock where ral_id = p_ral_id) then
    raise exception 'RAL_CON_CARGA|El RAL tiene artículos en Tránsito: devuélvelos antes de anular';
  end if;

  update public.rep_ral set estado = 'anulado' where id = p_ral_id;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function
  public.rep_pickear_linea(uuid, uuid),
  public.rep_despachar_ral(uuid),
  public.rep_devolver_linea(uuid),
  public.rep_anular_ral(uuid)
to authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 5) POLÍTICA rep_ral_detalle.delete: operario edita su RAL en curso
-- ────────────────────────────────────────────────────────────────────
drop policy if exists "rep_ral_detalle_delete" on public.rep_ral_detalle;
create policy "rep_ral_detalle_delete" on public.rep_ral_detalle
  for delete to authenticated
  using (
    public.tiene_permiso(auth.uid(), 'repuestos.crear')
    and exists (
      select 1 from public.rep_ral
      where rep_ral.id = rep_ral_detalle.ral_id
        and rep_ral.estado = 'registrado'
    )
  );

-- ═══════════════════════════════════════════════════════════════════
-- Verificación post-aplicación:
--   select proname from pg_proc where proname like 'rep_%' order by 1;
--     → rep_anular_ral · rep_crear_loncheras · rep_despachar_ral ·
--       rep_devolver_linea · rep_ocupacion_loncheras ·
--       rep_pickear_linea · rep_registrar_ingreso · rep_touch_updated_at
--   select count(*) from pg_policies where tablename='rep_ral_detalle'; → 4
-- ═══════════════════════════════════════════════════════════════════
