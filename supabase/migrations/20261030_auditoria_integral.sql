-- ═══════════════════════════════════════════════════════════════════
-- 20261030_auditoria_integral.sql — Auditoría integral de la app (9 pasos)
-- Fixes de BD detectados por la auditoría 2026-10-30:
--   DB3 · piso_auto_estructura_sector: SECURITY DEFINER sin search_path
--         fijado (riesgo de hijack de search_path) → SET search_path.
--   K1  · confirmar_correo_en_auth(correo, password): la auto-confirmación
--         en login estaba DOBLEMENTE rota (la Edge Function exige sesión
--         admin que no existe durante el login, y el id llegaba vacío).
--         Esta RPC SECURITY DEFINER verifica las credenciales con bcrypt
--         (pgcrypto) contra auth.users y SOLO entonces confirma: quien no
--         conoce la contraseña no puede confirmar nada.
--   K2  · piso_registrar_movimiento: rechazar _detalles vacíos — antes
--         insertaba la CABECERA aunque no hubiera detalles (movimiento
--         fantasma con numero_operacion consumido).
--   E2  · transito_registrar_envio: tolerancia EPS en el anti-sobreenvío
--         (igual que el cliente): un pendiente con residuo binario
--         (80.0000001) rechazaba un envío de 80 que la UI sí aceptaba.
--   DB2 · Higiene de privilegios: revocar INSERT/UPDATE/DELETE del rol
--         anon en TODAS las tablas públicas (RLS ya lo bloqueaba — no hay
--         policies para anon — pero el grant era innecesario) y dejarlo
--         fijado para tablas futuras.
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- DB3 · search_path de la función definer sin fijar
-- ─────────────────────────────────────────────────────────────
alter function public.piso_auto_estructura_sector() set search_path to 'public';

-- ─────────────────────────────────────────────────────────────
-- K1 · Auto-confirmación de email con prueba de contraseña
-- ─────────────────────────────────────────────────────────────
create or replace function public.confirmar_correo_en_auth(p_correo text, p_password text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_id   uuid;
  v_hash text;
begin
  if p_correo is null or btrim(p_correo) = '' or p_password is null or p_password = '' then
    return false;
  end if;

  select id, encrypted_password
    into v_id, v_hash
    from auth.users
   where lower(email) = lower(btrim(p_correo))
   limit 1;

  if v_id is null or v_hash is null or v_hash = '' then
    return false;
  end if;

  -- GoTrue guarda contraseñas bcrypt ($2…). Solo ese formato es verificable
  -- con crypt(); cualquier otro formato (nunca debería ocurrir) → false.
  if left(v_hash, 2) <> '$2' then
    return false;
  end if;

  -- PRUEBA DE CREDENCIALES: sin la contraseña correcta no se confirma nada.
  if extensions.crypt(p_password, v_hash) <> v_hash then
    return false;
  end if;

  if (select email_confirmed_at from auth.users where id = v_id) is not null then
    return true; -- ya estaba confirmado
  end if;

  update auth.users
     set email_confirmed_at = now(),
         updated_at = now()
   where id = v_id;

  return true;
end;
$$;

grant execute on function public.confirmar_correo_en_auth(text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- K2 · piso_registrar_movimiento: rechazar detalles vacíos
-- (misma función, guard añadido tras la validación de tipo)
-- ─────────────────────────────────────────────────────────────
create or replace function public.piso_registrar_movimiento(_tipo text, _turno text, _detalles jsonb default '[]'::jsonb, _uuid_sync text default null::text, _codigo_inc text default null::text, _usuario_id text default null::text, _usuario_nombre text default null::text, _usuario_correo text default null::text, _posicion_id uuid default null::uuid)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_mov_id   uuid;
  v_num_out  bigint;
  v_detalle  jsonb;
  v_nivel_id uuid;
  v_txt      text;
  v_fecha    date;
  v_cantidad numeric;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'service_role') then
    raise exception 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar movimientos';
  end if;

  if _tipo not in ('ingreso', 'devolucion', 'stock_inicial') then
    raise exception 'TIPO_INVALIDO|piso_registrar_movimiento solo acepta ingreso/devolucion/stock_inicial (las salidas van por piso_salida_posicion)';
  end if;

  -- v9 (auditoría 2026-10-30, K2): sin detalles NO se crea cabecera — antes
  -- quedaba un movimiento fantasma con numero_operacion consumido.
  if _detalles is null or jsonb_array_length(_detalles) = 0 then
    raise exception 'DETALLES_REQUERIDOS|El movimiento necesita al menos un detalle (artículo y cantidad)';
  end if;

  -- Idempotencia
  if _uuid_sync is not null and _uuid_sync <> '' then
    select id into v_mov_id from piso_movimientos where uuid_sync = _uuid_sync limit 1;
    if v_mov_id is not null then
      return jsonb_build_object('success', true, 'id', v_mov_id, 'idempotent', true);
    end if;
  end if;

  -- Locks por nivel (orden determinista)
  if _detalles is not null and jsonb_array_length(_detalles) > 0 then
    for v_nivel_id in
      select distinct (d->>'nivel_id')::uuid
      from jsonb_array_elements(_detalles) as d
      order by 1
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_nivel_id::text, 0));
    end loop;
  end if;

  -- Cabecera (numero_operacion por SECUENCIA; codigo_inc y posicion_id opcionales)
  insert into piso_movimientos (tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, codigo_inc, posicion_id)
  values (_tipo, now(), _turno, nullif(btrim(_usuario_id), '')::uuid, _usuario_nombre, _usuario_correo, _uuid_sync, nullif(_codigo_inc, ''), _posicion_id)
  returning id, numero_operacion into v_mov_id, v_num_out;

  -- Detalles (lote + fecha tolerante)
  for v_detalle in select * from jsonb_array_elements(_detalles)
  loop
    -- v7 (auditoría 2026-10-21): rechazar detalles con cantidad <= 0.
    -- Antes se insertaban con COALESCE(..., 0): filas "fantasma" con 0.
    v_cantidad := coalesce((v_detalle->>'cantidad')::numeric, 0);
    if v_cantidad <= 0 then
      raise exception 'CANTIDAD_INVALIDA|Cada detalle debe tener cantidad mayor que cero';
    end if;

    v_txt   := v_detalle->>'fecha_vencimiento';
    v_fecha := null;
    if v_txt is not null and v_txt <> '' and v_txt <> 'null' then
      begin
        v_fecha := to_date(v_txt, 'YYYY-MM-DD');
      exception when others then
        begin
          v_fecha := v_txt::timestamptz::date;
        exception when others then
          v_fecha := null;
        end;
      end;
    end if;

    -- v8 (auditoría 2026-10-23): año absurdo corrompe el FEFO (2000–2100).
    if v_fecha is not null and
       (extract(year from v_fecha) < 2000 or extract(year from v_fecha) > 2100) then
      raise exception 'FECHA_INVALIDA|El año del vencimiento (%) es inválido: debe estar entre 2000 y 2100', v_fecha;
    end if;

    insert into piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    values (
      v_mov_id,
      (v_detalle->>'nivel_id')::uuid,
      (v_detalle->>'bloque_id')::uuid,
      v_cantidad,
      v_fecha,
      nullif(btrim(coalesce(v_detalle->>'lote', '')), '')
    );
  end loop;

  return jsonb_build_object('success', true, 'id', v_mov_id, 'numero_operacion', v_num_out);
end;
$function$;

-- ─────────────────────────────────────────────────────────────
-- E2 · transito_registrar_envio: EPS en el anti-sobreenvío
-- (misma función; único cambio: p_cantidad > v_pendiente + 0.0005)
-- ─────────────────────────────────────────────────────────────
create or replace function public.transito_registrar_envio(p_recepcion_id uuid, p_tipo_destino text, p_cantidad numeric, p_turno text, p_usuario_id uuid, p_usuario_nombre text, p_usuario_correo text, p_uuid_sync text, p_rack jsonb default null::jsonb, p_piso jsonb default null::jsonb, p_ubicacion text default ''::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row public.recepcion_registros%rowtype;
  v_envios jsonb;
  v_enviados numeric;
  v_pendiente numeric;
  v_nuevo jsonb;
  v_lote text;
  v_venc date;
  v_codigo text;
  v_descripcion text;
  v_un text;
  v_prov text;
  v_res jsonb;
  v_mov_id uuid;
  v_bloque_piso_id uuid;
begin
  -- GUARD de autorización: la RPC es SECURITY DEFINER (escribe en movimientos,
  -- piso_movimientos, recepcion_registros). Nunca ejecutable por anon.
  if coalesce(auth.role(), '') not in ('service_role', 'authenticated') then
    raise exception 'NO_AUTORIZADO|Solo usuarios autenticados pueden registrar envíos de Tránsito';
  end if;

  if p_tipo_destino not in ('rack', 'piso') then
    raise exception 'DESTINO_INVALIDO|El destino debe ser rack o piso (recibido: %)', p_tipo_destino;
  end if;
  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'CANTIDAD_INVALIDA|La cantidad a transferir debe ser mayor que cero';
  end if;
  if p_uuid_sync is null or trim(p_uuid_sync) = '' then
    raise exception 'UUID_REQUERIDO|Falta el identificador único del envío';
  end if;

  -- Lock por fila de recepción: dos envíos simultáneos del mismo artículo se
  -- serializan y el anti-sobreenvío siempre ve el total real.
  perform pg_advisory_xact_lock(hashtextextended(p_recepcion_id::text, 7771));

  select * into v_row from public.recepcion_registros where id = p_recepcion_id;
  if not found then
    raise exception 'RECEPCION_NO_EXISTE|La fila de recepción ya no existe';
  end if;

  v_envios := coalesce(v_row.transito -> 'envios', '[]'::jsonb);

  -- IDEMPOTENCIA: mismo uuid del envío => ya registrado, devolver éxito sin tocar nada
  if exists (
    select 1 from jsonb_array_elements(v_envios) as e
    where e ->> 'uuid' = p_uuid_sync
  ) then
    return jsonb_build_object('ok', true, 'duplicado', true, 'recepcion_id', p_recepcion_id);
  end if;

  -- ANTI-SOBREENVÍO: lo enviado no puede superar la cantidad registrada.
  -- v9 (auditoría 2026-10-30, E2): EPS 0.0005 igual que el cliente — un
  -- pendiente con residuo binario (p. ej. 80.0000001) no rechaza un envío
  -- de 80 que la UI sí acepta.
  select coalesce(sum((e ->> 'cantidad')::numeric), 0) into v_enviados
  from jsonb_array_elements(v_envios) as e;
  v_pendiente := v_row.cantidad - v_enviados;
  if p_cantidad > v_pendiente + 0.0005 then
    raise exception 'OVER_ISSUE|La cantidad a transferir (%) excede el pendiente de % (%): excedente %',
      p_cantidad, v_row.codigo, v_pendiente, (p_cantidad - v_pendiente);
  end if;

  -- Regla TRÁNSITO (v2 2026-10-20): SIN lote o SIN fecha de vencimiento ya NO
  -- bloquea. El proveedor a veces no trae esos datos; se transfieren CON
  -- confirmación explícita en la UI y luego se completan/corrigen con
  -- editar_lote (v1/v2) en Racks/Piso. lote='' se normaliza a NULL abajo.

  v_lote := trim(coalesce(v_row.lote, ''));

  -- v8 (auditoría 2026-10-23): si la fila de Recepción trae un vencimiento con
  -- año absurdo (typo histórico: 0202/3027/…), NO se propaga a Racks/Piso:
  -- viaja como sin fecha (la regla v2 ya permite transferir sin fecha con
  -- confirmación) y el flujo de tránsito NO se bloquea. La fila original se
  -- corrige en Recepción / editar_lote.
  v_venc := v_row.fecha_vencimiento;
  -- FIX 2026-10-30: la asignación DEBE ir ANTES del guard v8 — estaba
  -- después y el check corría sobre NULL (código muerto): los
  -- vencimientos absurdos pasaban crudos y FECHA_INVALIDA bloqueaba
  -- la transferencia en vez de viajar «sin fecha» como diseñó v8.
  if v_venc is not null and
     (extract(year from v_venc) < 2000 or extract(year from v_venc) > 2100) then
    v_venc := null;
  end if;

  v_codigo := upper(trim(v_row.codigo));
  v_descripcion := v_row.descripcion;
  v_un := v_row.unidad_medida;
  v_prov := v_row.proveedor;

  if p_tipo_destino = 'rack' then
    if p_rack is null or coalesce(p_rack ->> 'bloque', '') = '' then
      raise exception 'UBICACION_RACK_REQUERIDA|Falta la ubicación del rack (bloque/torre/piso/posición)';
    end if;
    -- Ingreso NATIVO en Racks (misma RPC que usa el módulo) — misma transacción:
    -- si esto falla, NO se marca nada en Tránsito. Acepta v_venc NULL y
    -- lote NULL ('' → NULLIF: "sin lote" en un solo convenio).
    v_res := public.registrar_movimiento_kardex(
      'ingreso',
      p_rack ->> 'bloque', p_rack ->> 'torre', p_rack ->> 'piso', p_rack ->> 'posicion',
      v_codigo, v_descripcion, v_un, p_cantidad, v_venc, p_turno,
      p_usuario_id, p_usuario_nombre, p_usuario_correo, v_prov,
      p_uuid_sync, null, nullif(v_lote, '')
    );
  else
    if p_piso is null or coalesce(p_piso ->> 'nivel_id', '') = '' then
      raise exception 'UBICACION_PISO_REQUERIDA|Falta el nivel de destino del piso';
    end if;

    -- Bloque del catálogo Piso: resolver por código; crearlo si no existe
    -- (puente Recepción → Piso sin doble digitación).
    select id into v_bloque_piso_id from public.piso_bloques where codigo = v_codigo;
    if not found then
      insert into public.piso_bloques (codigo, descripcion, unidad)
      values (v_codigo, v_descripcion, v_un)
      on conflict (codigo) do nothing;
      select id into v_bloque_piso_id from public.piso_bloques where codigo = v_codigo;
    end if;

    -- Ingreso NATIVO en Piso (cabecera + detalle, igual que registrarIngresoPosicion).
    -- fecha_vencimiento y lote son nullable: NULL = sin dato (se completa luego).
    insert into public.piso_movimientos (tipo, turno, usuario_id, usuario_nombre, usuario_correo, uuid_sync, posicion_id)
    values (
      'ingreso', p_turno, p_usuario_id, p_usuario_nombre, p_usuario_correo,
      p_uuid_sync, nullif(p_piso ->> 'posicion_id', '')::uuid
    ) returning id into v_mov_id;

    insert into public.piso_movimiento_detalles (movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote)
    values (v_mov_id, (p_piso ->> 'nivel_id')::uuid, v_bloque_piso_id, p_cantidad, v_venc, nullif(v_lote, ''));
  end if;

  -- Marca TRÁNSITO sobre la fila de recepción (historial completo por artículo)
  v_nuevo := jsonb_build_object(
    'uuid', p_uuid_sync,
    'fecha', to_char(now() at time zone 'America/Lima', 'YYYY-MM-DD HH24:MI'),
    'destino', p_tipo_destino,
    'ubicacion', coalesce(p_ubicacion, ''),
    'cantidad', p_cantidad,
    'usuario_id', p_usuario_id,
    'usuario_nombre', p_usuario_nombre,
    'turno', p_turno,
    'rack', p_rack,
    'piso', p_piso
  );
  update public.recepcion_registros
  set transito = jsonb_build_object('v', 1, 'envios', (v_envios || jsonb_build_array(v_nuevo)))
  where id = p_recepcion_id;

  v_enviados := v_enviados + p_cantidad;
  v_pendiente := v_row.cantidad - v_enviados;
  return jsonb_build_object(
    'ok', true,
    'duplicado', false,
    'recepcion_id', p_recepcion_id,
    'enviados', v_enviados,
    'pendiente', v_pendiente,
    'estado', case when v_pendiente <= 0 then 'COMPLETO' else 'PARCIAL' end
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────
-- DB2 · Higiene: sin escrituras directas del rol anon
-- (RLS ya lo bloqueaba — no hay policies para anon; el grant era basura
-- heredada de los defaults de Supabase)
-- ─────────────────────────────────────────────────────────────
revoke insert, update, delete on all tables in schema public from anon;
alter default privileges in schema public revoke insert, update, delete on tables from anon;
