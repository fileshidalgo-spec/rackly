-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY · REPUESTOS · 2026-11-17 — EDICIÓN MIXTA y ELIMINACIÓN CON REVERSA
--
-- Pedido del usuario: «en mercadería repuestos también debería poder editar y
-- eliminar». Hasta hoy ambas operaciones exigían guía 100% en tránsito
-- (GUIA_YA_UBICADA): con un solo artículo ubicado, los botones quedaban
-- deshabilitados para siempre.
--
-- EDICIÓN (rep_editar_recepcion): la cabecera (guía/OC/DAM) es SIEMPRE
-- editable. Las líneas YA UBICADAS se conservan pero quedan CONGELADAS
-- (artículo y cantidad intocables — su stock y su kardex dependen de ellas;
-- el proveedor sí es dato del documento). Las en tránsito se editan, quitan
-- y agregan con libertad. Todo-o-nada, advisory lock y UPDATE por id
-- (el QR ya impreso conserva su uuid) — igual que antes.
--
-- ELIMINACIÓN (rep_eliminar_recepcion): los artículos ya ubicados NO se
-- borran a ciegas — por cada uno se desconta su stock de la lonchera (a 0 se
-- elimina la fila y se libera el cupo de 15) y se registra una DEVOLUCIÓN en
-- el kardex (traza del ingreso original intacta). Si ya hubo salidas que
-- dejarían el stock negativo o huérfano, la BD RECHAZA con STOCK_CONSUMIDO —
-- nunca corrompe el kardex.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────── EDICIÓN MIXTA ─────────────────────────────
CREATE OR REPLACE FUNCTION public.rep_editar_recepcion(p_recepcion_id uuid, p_guia text, p_oc text, p_dam text, p_lineas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user       uuid := auth.uid();
  v_guia       text := coalesce(trim(p_guia), '');
  v_linea      jsonb;
  v_art        public.rep_articulos;
  v_existente  public.rep_recepcion_lineas;
  v_linea_id   uuid;
  v_mantener   uuid[] := '{}';
  v_nuevos_ids jsonb := '[]'::jsonb;
  i            int;
begin
  -- Guard de permiso (mismo cuadro que el resto del módulo)
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.gestionar') then
      raise exception 'NO_AUTORIZADO|Solo supervisores, coordinadores o administradores pueden editar guías';
    end if;
  end if;

  if p_recepcion_id is null then
    raise exception 'RECEPCION_REQUERIDA|Falta la guía a editar';
  end if;
  if v_guia = '' then
    raise exception 'GUIA_REQUERIDA|Ingresa el N° de Guía';
  end if;
  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'LINEAS_REQUERIDAS|La guía debe conservar al menos un artículo';
  end if;

  -- Serializa edición/eliminación concurrentes de la MISMA guía
  perform pg_advisory_xact_lock(hashtextextended('rep-rec-edit-' || p_recepcion_id::text, 6211));

  if not exists (select 1 from public.rep_recepciones where id = p_recepcion_id) then
    raise exception 'RECEPCION_NO_EXISTE|La guía ya no existe (¿alguien la eliminó?)';
  end if;

  -- Bloquea TODAS las líneas: espera ubicaciones de Tránsito en curso y
  -- bloquea nuevas hasta el commit de esta transacción.
  perform 1 from public.rep_recepcion_lineas
    where recepcion_id = p_recepcion_id
    for update;

  -- Valida TODAS las líneas ANTES de escribir nada (todo-o-nada).
  -- EDICIÓN MIXTA: ubicadas = conservadas pero CONGELADAS (artículo y
  -- cantidad idénticos a la BD); en tránsito = libres.
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
    if v_linea ->> 'id' is not null then
      v_linea_id := (v_linea ->> 'id')::uuid;
      v_mantener := array_append(v_mantener, v_linea_id);
      select * into v_existente
        from public.rep_recepcion_lineas
        where id = v_linea_id and recepcion_id = p_recepcion_id;
      if not found then
        raise exception 'LINEA_NO_EXISTE|Una línea a editar ya no pertenece a la guía (recarga la página)';
      end if;
      if v_existente.estado = 'ubicado'
         and (v_existente.articulo_id <> v_art.id
              or v_existente.cantidad <> (v_linea ->> 'cantidad')::numeric) then
        raise exception 'LINEA_UBICADA_CONGELADA|El artículo % ya está ubicado: su cantidad y su artículo no se pueden cambiar ni quitar (el stock y el kardex dependen de él). Para revertirlo, elimina la guía completa — la BD genera la devolución.', v_existente.codigo;
      end if;
    end if;
  end loop;

  -- Líneas que quedaron fuera de la edición: NINGUNA puede estar ubicada.
  if exists (
    select 1 from public.rep_recepcion_lineas
    where recepcion_id = p_recepcion_id
      and estado = 'ubicado'
      and not (id = any(v_mantener))
  ) then
    raise exception 'LINEA_UBICADA_CONGELADA|Hay artículos ya ubicados que quitaste de la edición: no se pueden eliminar de la guía (su stock y su kardex dependen de ellos). Elimina la guía completa si necesitas revertirlos.';
  end if;

  -- 1) Cabecera — SIEMPRE editable (guía/OC/DAM son datos del documento)
  update public.rep_recepciones
    set guia = v_guia,
        oc   = coalesce(trim(p_oc), ''),
        dam  = coalesce(trim(p_dam), '')
    where id = p_recepcion_id;

  -- 2) Líneas que quedaron fuera (todas en tránsito — validado arriba)
  delete from public.rep_recepcion_lineas
    where recepcion_id = p_recepcion_id
      and not (id = any(v_mantener));

  -- 3) Aplica cada línea en el orden recibido
  for i in 0 .. jsonb_array_length(p_lineas) - 1 loop
    v_linea := p_lineas -> i;
    select * into v_art from public.rep_articulos where id = (v_linea ->> 'articulo_id')::uuid;
    if v_linea ->> 'id' is not null then
      v_linea_id := (v_linea ->> 'id')::uuid;
      select * into v_existente
        from public.rep_recepcion_lineas
        where id = v_linea_id and recepcion_id = p_recepcion_id;
      if v_existente.estado = 'ubicado' then
        -- CONGELADA: solo el proveedor es dato del documento editable —
        -- el artículo, la cantidad y el QR (uuid) quedan intactos.
        update public.rep_recepcion_lineas
          set proveedor = coalesce(trim(v_linea ->> 'proveedor'), '')
          where id = v_linea_id
            and recepcion_id = p_recepcion_id;
      else
        update public.rep_recepcion_lineas
          set articulo_id = v_art.id,
              codigo      = v_art.codigo,
              descripcion = v_art.descripcion,
              und         = v_art.und,
              cantidad    = (v_linea ->> 'cantidad')::numeric,
              proveedor   = coalesce(trim(v_linea ->> 'proveedor'), '')
          where id = v_linea_id
            and recepcion_id = p_recepcion_id;
      end if;
      if not found then
        raise exception 'LINEA_NO_EXISTE|Una línea a editar ya no pertenece a la guía (recarga la página)';
      end if;
    else
      insert into public.rep_recepcion_lineas
        (recepcion_id, articulo_id, codigo, descripcion, und, cantidad, proveedor, estado, uuid_sync)
      values
        (p_recepcion_id, v_art.id, v_art.codigo, v_art.descripcion, v_art.und,
         (v_linea ->> 'cantidad')::numeric, coalesce(trim(v_linea ->> 'proveedor'), ''),
         'en_transito', gen_random_uuid()::text)
      returning id into v_linea_id;
    end if;
    v_nuevos_ids := v_nuevos_ids || to_jsonb(v_linea_id);
  end loop;

  return jsonb_build_object('ok', true, 'recepcion_id', p_recepcion_id, 'linea_ids', v_nuevos_ids);
end;
$function$;

-- ─────────────────────── ELIMINACIÓN CON REVERSA ───────────────────────────
CREATE OR REPLACE FUNCTION public.rep_eliminar_recepcion(p_recepcion_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user         uuid := auth.uid();
  v_rec          public.rep_recepciones;
  v_linea        public.rep_recepcion_lineas;
  v_stock        public.rep_stock;
  v_lado         text;
  v_lineas       int := 0;
  v_devoluciones int := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if coalesce(auth.role(), '') <> 'authenticated'
       or not public.tiene_permiso(v_user, 'repuestos.eliminar') then
      raise exception 'NO_AUTORIZADO|Solo supervisores, coordinadores o administradores pueden eliminar guías';
    end if;
  end if;

  if p_recepcion_id is null then
    raise exception 'RECEPCION_REQUERIDA|Falta la guía a eliminar';
  end if;

  -- MISMA llave de advisory lock que rep_editar_recepcion: nunca corren a la
  -- vez sobre la misma guía.
  perform pg_advisory_xact_lock(hashtextextended('rep-rec-edit-' || p_recepcion_id::text, 6211));

  select * into v_rec from public.rep_recepciones where id = p_recepcion_id;
  if not found then
    raise exception 'RECEPCION_NO_EXISTE|La guía ya no existe (¿alguien la eliminó?)';
  end if;

  perform 1 from public.rep_recepcion_lineas
    where recepcion_id = p_recepcion_id
    for update;

  -- ELIMINACIÓN CON REVERSA: por cada artículo ya ubicado, desconta su stock
  -- de la lonchera (a 0 se elimina la fila y se libera el cupo de 15) y
  -- registra una DEVOLUCIÓN en el kardex. El ingreso original NUNCA se
  -- borra: la traza queda completa. Si ya hubo salidas que dejarían el
  -- stock negativo o huérfano, RECHAZA (STOCK_CONSUMIDO) — nada a medias.
  for v_linea in
    select * from public.rep_recepcion_lineas
    where recepcion_id = p_recepcion_id and estado = 'ubicado'
    order by created_at
  loop
    select * into v_stock
      from public.rep_stock
      where lonchera_id = v_linea.lonchera_id
        and articulo_id = v_linea.articulo_id
      for update;
    if not found then
      raise exception 'STOCK_CONSUMIDO|El stock de % ya no está en su lonchera (ajuste o corrección previa): no se puede revertir automáticamente', v_linea.codigo;
    end if;
    if v_stock.cantidad < v_linea.cantidad then
      raise exception 'STOCK_CONSUMIDO|De % quedan % en lonchera (menos que los % recibidos): ya hubo salidas y eliminar la guía dejaría el kardex inconsistente', v_linea.codigo, v_stock.cantidad, v_linea.cantidad;
    end if;
    if v_stock.cantidad = v_linea.cantidad then
      delete from public.rep_stock where id = v_stock.id;
    else
      update public.rep_stock
        set cantidad = cantidad - v_linea.cantidad,
            updated_at = now()
        where id = v_stock.id;
    end if;

    select l.lado into v_lado from public.rep_loncheras l where l.id = v_linea.lonchera_id;

    insert into public.rep_movimientos (
      tipo, articulo_id, codigo, descripcion, und, cantidad,
      origen_ubicacion_id, origen_lado, referencia, usuario_id, usuario_nombre,
      guia, oc, dam, proveedor
    ) values (
      'devolucion', v_linea.articulo_id, v_linea.codigo, v_linea.descripcion, v_linea.und, v_linea.cantidad,
      v_linea.ubicacion_id, v_lado, 'Reversa de recepción · guía ' || v_rec.guia, v_user,
      coalesce((select nombre from public.profiles where id = v_user), ''),
      v_rec.guia, v_rec.oc, v_rec.dam, v_linea.proveedor
    );
    v_devoluciones := v_devoluciones + 1;
  end loop;

  select count(*) into v_lineas from public.rep_recepcion_lineas where recepcion_id = p_recepcion_id;

  delete from public.rep_recepcion_lineas where recepcion_id = p_recepcion_id;
  delete from public.rep_recepciones where id = p_recepcion_id;

  return jsonb_build_object('ok', true, 'lineas_eliminadas', v_lineas, 'lineas_reversadas', v_devoluciones);
end;
$function$;
