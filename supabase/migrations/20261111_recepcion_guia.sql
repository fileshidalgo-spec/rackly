-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY · REPUESTOS — Recepción con documento de guía (2026-11-11)
--
-- El ingreso de Repuestos ahora viaja bajo un DOCUMENTO: N° de Guía, N° de
-- OC, N° de DAM y Proveedor (único para toda la guía o por artículo).
--
-- Diseño (mínimo conflicto, todo aditivo):
--   1) 4 columnas de documento en rep_movimientos. Las llena SOLO el ingreso
--      (Recepción); traslado/salida/devolución quedan con '' — sus RPCs
--      insertan con lista explícita de columnas, así que no cambian nada.
--   2) Índice por guía para la reimpresión de rótulos (listar por documento).
--   3) rep_registrar_ingreso gana 4 argumentos OPCIONALES AL FINAL:
--      los llamadores existentes (4 args) siguen resolviendo a la MISMA
--      función — compatibilidad total con Recepción desplegada.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Columnas de documento ───────────────────────────────────────────────
ALTER TABLE public.rep_movimientos
  ADD COLUMN IF NOT EXISTS guia      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS oc        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS dam       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS proveedor text NOT NULL DEFAULT '';

-- ── 2) Índice de reimpresión por guía ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rep_movs_guia
  ON public.rep_movimientos (guia);

-- ── 3) RPC extendida (4 args opcionales al final) ──────────────────────────
CREATE OR REPLACE FUNCTION public.rep_registrar_ingreso(
  p_articulo_id uuid,
  p_lonchera_id uuid,
  p_cantidad numeric,
  p_referencia text DEFAULT ''::text,
  p_guia text DEFAULT ''::text,
  p_oc text DEFAULT ''::text,
  p_dam text DEFAULT ''::text,
  p_proveedor text DEFAULT ''::text
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
$function$;
