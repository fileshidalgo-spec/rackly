-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — Recepción REP: EDITAR y ELIMINAR guías ya recepcionadas (2026-11-12)
-- Pedido: que supervisores/coordinadores/administradores puedan corregir el
-- documento (guía/OC/DAM, códigos, cantidades, proveedores, líneas) y borrar
-- la guía si se debe. Paridad con la Recepción de Insumos (Revisar/editar +
-- Eliminar guía), pero con las reglas físicas del almacén REP:
--
--   · Solo guías 100% «en tránsito» son editables/borrables. Si una línea
--     ya fue UBICADA por Tránsito, su stock y kardex ya se escribieron
--     (rep_ubicar_desde_transito) — modificar/borrar el documento dejaría
--     stock huérfano y kardex sin documento. La corrección física posterior
--     vive en el almacén (salidas/traslados desde el mapa de Ubicaciones).
--   · Las líneas conservan SU uuid al editarse (UPDATE en lugar de
--     reinsertar): los rótulos QR ya impresos siguen resolviendo a la misma
--     línea en Tránsito. Las líneas nuevas reciben uuid nuevo (sus rótulos
--     se re-imprimen desde el modal que abre el guardado).
--   · Escritura 100% vía RPC SECURITY DEFINER con guard de permiso (las
--     tablas siguen solo-lectura por RLS para el cliente):
--       - rep_editar_recepcion    → tiene_permiso(user, 'repuestos.gestionar')
--       - rep_eliminar_recepcion  → tiene_permiso(user, 'repuestos.eliminar')
--     Ambos permisos tienen por defecto EXACTAMENTE los roles del pedido
--     (supervisor_almacen, supervisor_operaciones, coordinador_operaciones
--     + admin) — sin tocar la matriz.
--   · Carrera con Tránsito: ambas RPCs toman FOR UPDATE sobre TODAS las
--     líneas de la guía ANTES de decidir. Si una ubicación está en curso,
--     la edición/eliminación espera su commit y entonces ve «ubicado» y
--     rechaza. Además, un advisory lock por recepcion_id serializa
--     ediciones/borrados concurrentes de la misma guía (y entre sí).
--   · Nombres NUEVOS (sin sobrecargas): cero riesgo PGRST203.
--   · Validación fail-fast todo-o-nada (mismo estilo rep_registrar_recepcion).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) EDITAR recepción ────────────────────────────────────────────────────
-- Reemplaza cabecera + conjunto de líneas de la guía (sincronización por id:
-- líneas con id → UPDATE conservando uuid; sin id → INSERT; las que quedan
-- fuera → DELETE). Devuelve linea_ids en el MISMO orden que p_lineas para
-- que el cliente re-genere los rótulos (contrato igual a rep_registrar_recepcion).
CREATE OR REPLACE FUNCTION public.rep_editar_recepcion(
  p_recepcion_id uuid,
  p_guia text,
  p_oc text,
  p_dam text,
  p_lineas jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user       uuid := auth.uid();
  v_guia       text := coalesce(trim(p_guia), '');
  v_ubicadas   int;
  v_linea      jsonb;
  v_art        public.rep_articulos;
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

  select count(*) into v_ubicadas
    from public.rep_recepcion_lineas
    where recepcion_id = p_recepcion_id and estado = 'ubicado';
  if v_ubicadas > 0 then
    raise exception 'GUIA_YA_UBICADA|La guía tiene % artículo(s) ya ubicados: no se puede editar. Solo guías 100%% en tránsito se editan.', v_ubicadas;
  end if;

  -- Valida TODAS las líneas ANTES de escribir nada (todo-o-nada)
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
      v_mantener := array_append(v_mantener, (v_linea ->> 'id')::uuid);
    end if;
  end loop;

  -- 1) Cabecera
  update public.rep_recepciones
    set guia = v_guia,
        oc   = coalesce(trim(p_oc), ''),
        dam  = coalesce(trim(p_dam), '')
    where id = p_recepcion_id;

  -- 2) Líneas que quedaron fuera de la edición (con array vacío: todas)
  delete from public.rep_recepcion_lineas
    where recepcion_id = p_recepcion_id
      and not (id = any(v_mantener));

  -- 3) Aplica cada línea en el orden recibido
  for i in 0 .. jsonb_array_length(p_lineas) - 1 loop
    v_linea := p_lineas -> i;
    select * into v_art from public.rep_articulos where id = (v_linea ->> 'articulo_id')::uuid;
    if v_linea ->> 'id' is not null then
      v_linea_id := (v_linea ->> 'id')::uuid;
      update public.rep_recepcion_lineas
        set articulo_id = v_art.id,
            codigo      = v_art.codigo,
            descripcion = v_art.descripcion,
            und         = v_art.und,
            cantidad    = (v_linea ->> 'cantidad')::numeric,
            proveedor   = coalesce(trim(v_linea ->> 'proveedor'), '')
        where id = v_linea_id
          and recepcion_id = p_recepcion_id;
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

-- ── 2) ELIMINAR recepción (solo si nada ubicado) ───────────────────────────
CREATE OR REPLACE FUNCTION public.rep_eliminar_recepcion(p_recepcion_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user     uuid := auth.uid();
  v_ubicadas int;
  v_lineas   int;
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

  perform 1 from public.rep_recepcion_lineas
    where recepcion_id = p_recepcion_id
    for update;

  select count(*) into v_ubicadas
    from public.rep_recepcion_lineas
    where recepcion_id = p_recepcion_id and estado = 'ubicado';
  if v_ubicadas > 0 then
    raise exception 'GUIA_YA_UBICADA|La guía tiene % artículo(s) ya ubicados: no se puede eliminar (dejaría stock y kardex huérfanos).', v_ubicadas;
  end if;

  if not exists (select 1 from public.rep_recepciones where id = p_recepcion_id) then
    raise exception 'RECEPCION_NO_EXISTE|La guía ya no existe (¿alguien la eliminó?)';
  end if;

  select count(*) into v_lineas from public.rep_recepcion_lineas where recepcion_id = p_recepcion_id;

  delete from public.rep_recepcion_lineas where recepcion_id = p_recepcion_id;
  delete from public.rep_recepciones where id = p_recepcion_id;

  return jsonb_build_object('ok', true, 'lineas_eliminadas', v_lineas);
end;
$function$;
