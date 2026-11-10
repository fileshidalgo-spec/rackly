-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY · REPUESTOS — Movimientos directos desde el mapa de Ubicaciones.
--
-- Paridad con Insumos (OcupacionTab): al hacer clic sobre una posición del
-- mapa se puede registrar INGRESO, SALIDA y TRASLADO sin pasar por
-- Recepción/RAL. El ingreso ya existe (rep_registrar_ingreso); esta
-- migración agrega las otras dos RPCs atómicas con el MISMO patrón:
--   · SECURITY DEFINER + guard de permiso 'repuestos.crear' en BD.
--   · Validaciones completas antes de tocar stock (FAIL FAST).
--   · Kardex (rep_movimientos) SIEMPRE se escribe en la misma transacción.
--
-- Reglas de negocio respetadas:
--   · Capacidad: máx. 15 artículos DISTINTOS por lonchera.
--   · Un artículo vive en UNA lonchera (el traslado es la excepción
--     controlada: descuenta origen y suma destino en la misma transacción).
--   · El stock estacionado en tránsito (rep_stock.ral_id, pre-picking de un
--     RAL) NO se toca: hay que despacharlo o devolverlo desde Tránsito.
--   · rep_stock queda sin fila cuando la cantidad llega a 0 (igual que
--     rep_despachar_ral); la lonchera vuelve a estar disponible.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- SALIDA directa de una lonchera (mapa de ubicaciones → «Salida»).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rep_registrar_salida(
  p_articulo_id uuid,
  p_lonchera_id uuid,
  p_cantidad   numeric,
  p_referencia text DEFAULT ''
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user     uuid := auth.uid();
  v_art      public.rep_articulos;
  v_lado     text;
  v_ubic_id  uuid;
  v_ubic_cod text;
  v_stock    public.rep_stock;
  v_restante numeric;
begin
  -- Guard de permiso (service_role interno o usuario con repuestos.crear)
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.crear') then
      raise exception 'NO_AUTORIZADO|No tienes permiso para registrar salidas en Repuestos';
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

  select l.lado, u.id, u.codigo
    into v_lado, v_ubic_id, v_ubic_cod
    from public.rep_loncheras l
    join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where l.id = p_lonchera_id;
  if not found then
    raise exception 'LONCHERA_NO_EXISTE|La lonchera de origen no existe';
  end if;

  -- El stock a descontar debe existir y NO estar estacionado en tránsito
  -- (ral_id lleno = pre-picking de un RAL: se despacha o devuelve en Tránsito)
  select * into v_stock
    from public.rep_stock
    where lonchera_id = p_lonchera_id and articulo_id = p_articulo_id
    for update;
  if not found then
    raise exception 'STOCK_NO_EXISTE|% no tiene stock en la lonchera %', v_art.codigo, v_ubic_cod;
  end if;
  if v_stock.ral_id is not null then
    raise exception 'STOCK_EN_TRANSITO|El stock de % en % está estacionado en tránsito (RAL): despáchalo o devuélvelo desde Tránsito', v_art.codigo, v_ubic_cod;
  end if;
  if v_stock.cantidad < p_cantidad then
    raise exception 'STOCK_INSUFICIENTE|Solo hay % en la lonchera % (pidiste %)', v_stock.cantidad, v_ubic_cod, p_cantidad;
  end if;

  v_restante := v_stock.cantidad - p_cantidad;
  if v_restante > 0 then
    update public.rep_stock
      set cantidad = v_restante, updated_at = now()
      where id = v_stock.id;
  else
    delete from public.rep_stock where id = v_stock.id;
  end if;

  insert into public.rep_movimientos (
    tipo, articulo_id, codigo, descripcion, und, cantidad,
    origen_ubicacion_id, origen_lado, referencia, usuario_id, usuario_nombre
  ) values (
    'salida', p_articulo_id, v_art.codigo, v_art.descripcion, v_art.und, p_cantidad,
    v_ubic_id, v_lado, coalesce(trim(p_referencia), ''), v_user,
    coalesce((select nombre from public.profiles where id = v_user), '')
  );

  return jsonb_build_object(
    'ok', true,
    'ubicacion', v_ubic_cod,
    'lado', v_lado,
    'restante', v_restante
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TRASLADO directo entre loncheras (mapa → «Traslado»): descuenta origen,
-- suma destino y escribe UN movimiento 'traslado' — todo atómico.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rep_registrar_traslado(
  p_articulo_id         uuid,
  p_lonchera_origen_id  uuid,
  p_lonchera_destino_id uuid,
  p_cantidad   numeric,
  p_referencia text DEFAULT ''
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user     uuid := auth.uid();
  v_art      public.rep_articulos;
  v_o_lado   text;
  v_o_ubic   uuid;
  v_o_cod    text;
  v_d_lado   text;
  v_d_ubic   uuid;
  v_d_cod    text;
  v_stock    public.rep_stock;
  v_restante numeric;
  v_ya_esta  boolean;
  v_llena    boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.crear') then
      raise exception 'NO_AUTORIZADO|No tienes permiso para trasladar en Repuestos';
    end if;
  end if;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'CANTIDAD_INVALIDA|La cantidad debe ser mayor que cero';
  end if;
  if p_lonchera_origen_id = p_lonchera_destino_id then
    raise exception 'DESTINO_IGUAL|La lonchera destino es la misma que la de origen';
  end if;

  select * into v_art from public.rep_articulos where id = p_articulo_id;
  if not found then
    raise exception 'ARTICULO_NO_EXISTE|El artículo no existe en el catálogo de Repuestos';
  end if;
  if not v_art.activo then
    raise exception 'ARTICULO_INACTIVO|El artículo está inactivo en el catálogo';
  end if;

  select l.lado, u.id, u.codigo into v_o_lado, v_o_ubic, v_o_cod
    from public.rep_loncheras l
    join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where l.id = p_lonchera_origen_id;
  if not found then
    raise exception 'LONCHERA_NO_EXISTE|La lonchera de origen no existe';
  end if;

  select l.lado, u.id, u.codigo into v_d_lado, v_d_ubic, v_d_cod
    from public.rep_loncheras l
    join public.rep_ubicaciones u on u.id = l.ubicacion_id
    where l.id = p_lonchera_destino_id;
  if not found then
    raise exception 'LONCHERA_NO_EXISTE|La lonchera destino no existe';
  end if;

  -- Stock en origen: existe, sin estacionar y con cantidad suficiente
  select * into v_stock
    from public.rep_stock
    where lonchera_id = p_lonchera_origen_id and articulo_id = p_articulo_id
    for update;
  if not found then
    raise exception 'STOCK_NO_EXISTE|% no tiene stock en la lonchera %', v_art.codigo, v_o_cod;
  end if;
  if v_stock.ral_id is not null then
    raise exception 'STOCK_EN_TRANSITO|El stock de % en % está estacionado en tránsito (RAL): despáchalo o devuélvelo desde Tránsito', v_art.codigo, v_o_cod;
  end if;
  if v_stock.cantidad < p_cantidad then
    raise exception 'STOCK_INSUFICIENTE|Solo hay % en la lonchera % (pidiste %)', v_stock.cantidad, v_o_cod, p_cantidad;
  end if;

  -- Capacidad en destino (si el artículo ya vive ahí, suma y no ocupa slot)
  select exists (
    select 1 from public.rep_stock
    where lonchera_id = p_lonchera_destino_id and articulo_id = p_articulo_id
  ) into v_ya_esta;
  if not v_ya_esta then
    select count(*) >= 15 into v_llena
      from public.rep_stock where lonchera_id = p_lonchera_destino_id;
    if v_llena then
      raise exception 'LONCHERA_LLENA|La lonchera % ya tiene 15 artículos distintos', v_d_cod;
    end if;
  end if;

  v_restante := v_stock.cantidad - p_cantidad;
  if v_restante > 0 then
    update public.rep_stock
      set cantidad = v_restante, updated_at = now()
      where id = v_stock.id;
  else
    delete from public.rep_stock where id = v_stock.id;
  end if;

  insert into public.rep_stock (lonchera_id, articulo_id, cantidad)
  values (p_lonchera_destino_id, p_articulo_id, p_cantidad)
  on conflict (lonchera_id, articulo_id)
  do update set cantidad = public.rep_stock.cantidad + excluded.cantidad,
                updated_at = now();

  insert into public.rep_movimientos (
    tipo, articulo_id, codigo, descripcion, und, cantidad,
    origen_ubicacion_id, origen_lado,
    destino_ubicacion_id, destino_lado,
    referencia, usuario_id, usuario_nombre
  ) values (
    'traslado', p_articulo_id, v_art.codigo, v_art.descripcion, v_art.und, p_cantidad,
    v_o_ubic, v_o_lado,
    v_d_ubic, v_d_lado,
    coalesce(trim(p_referencia), ''), v_user,
    coalesce((select nombre from public.profiles where id = v_user), '')
  );

  return jsonb_build_object(
    'ok', true,
    'origen', v_o_cod,
    'destino', v_d_cod,
    'lado_destino', v_d_lado
  );
end;
$function$;
