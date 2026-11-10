-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — Endurecimiento de RPCs sobrecargadas (PGRST203).
--
-- PostgREST no resuelve una llamada cuando DOS sobrecargas son aplicables a
-- los mismos parámetros nombrados (una con DEFAULT). Detectado 2026-11-11:
--
--   BUG REAL · rq_atender_item: la pestaña Atención (RqDetalle) llama SIN
--   p_toma (3 args) y PostgREST devolvía PGRST203 (candidatos: 3-arg y
--   4-arg con DEFAULT NULL) — la app degradaba silenciosamente al «Respaldo»
--   no atómico. Con el DEFAULT fuera, 3 args → solo la corta, 4 args → solo
--   la larga.
--
--   RIESGO LATENTE · rep_registrar_ingreso: 4 args eran ambiguos entre la
--   delega (4) y la completa (8 con DEFAULTs). La app nunca lo padece porque
--   envía los 8, pero queda blindado: 4 → delega, 8 → completa.
--
-- Cuerpos leídos de pg_get_functiondef en el momento de la migración: solo
-- se quitan los DEFAULT de la firma; nada más cambia.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS rep_registrar_ingreso(uuid,uuid,numeric,text,text,text,text,text);

CREATE OR REPLACE FUNCTION public.rep_registrar_ingreso(p_articulo_id uuid, p_lonchera_id uuid, p_cantidad numeric, p_referencia text, p_guia text, p_oc text, p_dam text, p_proveedor text)
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
    destino_ubicacion_id, destino_lado, referencia, usuario_id, usuario_nombre,
    guia, oc, dam, proveedor
  ) values (
    'ingreso', p_articulo_id, v_art.codigo, v_art.descripcion, v_art.und, p_cantidad,
    v_ubic_id, v_lado, coalesce(trim(p_referencia), ''), v_user,
    coalesce((select nombre from public.profiles where id = v_user), ''),
    coalesce(trim(p_guia), ''), coalesce(trim(p_oc), ''),
    coalesce(trim(p_dam), ''), coalesce(trim(p_proveedor), '')
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
$function$
;

DROP FUNCTION IF EXISTS rq_atender_item(uuid,numeric,text,jsonb);

CREATE OR REPLACE FUNCTION public.rq_atender_item(p_item_id uuid, p_cantidad numeric, p_usuario text, p_toma jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_item rq_atencion_items%ROWTYPE;
  v_pendientes integer;
  v_alguno boolean;
  v_suma_tomas numeric;
begin
  -- v8 (auditoría 2026-10-23): guard de rol, consistente con rq_atender_lote.
  IF COALESCE(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO|Solo usuarios autenticados pueden atender materiales';
  END IF;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a atender debe ser mayor que cero';
  end if;

  -- v10 (Task 27): si vienen posiciones, su suma debe ser la cantidad atendida.
  if p_toma is not null then
    if jsonb_typeof(p_toma) <> 'array' then
      raise exception 'TOMA_INVALIDA|El detalle de posiciones debe ser un arreglo';
    end if;
    select coalesce(sum((t->>'cantidad')::numeric), 0) into v_suma_tomas
      from jsonb_array_elements(p_toma) t
      where coalesce((t->>'cantidad')::numeric, 0) > 0;
    if abs(coalesce(v_suma_tomas, 0) - p_cantidad) > 0.0001 then
      raise exception 'TOMA_INVALIDA|La suma de las posiciones (%) no coincide con lo atendido (%)',
        v_suma_tomas, p_cantidad;
    end if;
  end if;

  -- v8: incremento ATÓMICO en un solo UPDATE.
  update rq_atencion_items set
    cantidad_atendida = cantidad_atendida + p_cantidad,
    usuario_atencion = coalesce(nullif(p_usuario, ''), usuario_atencion),
    atendido_en = case when cantidad_atendida + p_cantidad >= cantidad then now() else null end
  where id = p_item_id
  returning * into v_item;

  if not found then
    raise exception 'Artículo no encontrado (puede haber sido eliminado)';
  end if;

  -- v9 (Task 26): regla canónica de estado (unificada con revertir/editar).
  select count(*) into v_pendientes
    from rq_atencion_items
    where rq_id = v_item.rq_id and cantidad_atendida < cantidad;
  select coalesce(exists(
    select 1 from rq_atencion_items where rq_id = v_item.rq_id and cantidad_atendida > 0
  ), false) into v_alguno;

  update rq_atenciones set
    estado = case
      when v_pendientes = 0 then 'Atendido'
      when v_alguno then 'En proceso'
      else 'Pendiente' end
  where id = v_item.rq_id;

  -- v10 (Task 27): LEDGER de tomas para «Revisar». Con posiciones: una fila
  -- por posición; sin ellas: toma 'manual' (quién atendió y cuánto).
  if p_toma is not null and jsonb_array_length(p_toma) > 0 then
    insert into rq_atencion_tomas
      (rq_id, item_id, codigo, origen, cantidad, ubicacion, rack, piso, usuario_id, usuario_nombre, usuario_correo)
    select
      v_item.rq_id, v_item.id, v_item.codigo,
      case when coalesce(nullif(lower(trim(t->>'origen')), ''), '') in ('racks','piso','transito','manual')
           then lower(trim(t->>'origen')) else 'manual' end,
      (t->>'cantidad')::numeric,
      coalesce(rq_ubicacion_texto(t->'rack', t->'piso', t->>'ubicacion'), ''),
      t->'rack', t->'piso',
      auth.uid(), coalesce(p_usuario, ''), ''
    from jsonb_array_elements(p_toma) t
    where coalesce((t->>'cantidad')::numeric, 0) > 0;
  else
    insert into rq_atencion_tomas
      (rq_id, item_id, codigo, origen, cantidad, ubicacion, usuario_id, usuario_nombre, usuario_correo)
    values
      (v_item.rq_id, v_item.id, v_item.codigo, 'manual', p_cantidad, '', auth.uid(), coalesce(p_usuario, ''), '');
  end if;

  return to_json(v_item);
end $function$
;
