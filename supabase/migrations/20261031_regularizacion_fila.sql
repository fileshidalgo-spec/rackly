-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — Migración 2026-10-31 · Regularización de filas sobrantes (T173-00004274)
-- ═══════════════════════════════════════════════════════════════════════════
-- CASO: una guía registró MÁS cantidad de la realmente llegada (ej. guía
-- T173-00004274 · artículo 53414: 172 registrados vs 150 reales → 22 UN de
-- sobrante que "flotan" en Tránsito con el semáforo ROJO "Sin transferir"
-- para siempre, porque físicamente nunca existieron).
--
-- ANTES de esta migración NO existía camino de regularización:
--   · El editor de Recepción rechazaba quitar filas registradas por OTRO
--     usuario con un guard "ajenas" CIEGO AL ROL (modulos.ts): incluso un
--     admin/supervisor con `recepcion.eliminar` recibía ELIMINAR_BLOQUEADO,
--     aunque las políticas RLS de la BD SÍ se lo permitirían (permissive
--     recepcion_delete_auth + recepcion_registros_delete_permiso bajo la
--     restrictive recepcion_delete_restr = tiene_permiso). El guard del
--     cliente era MÁS estricto que la BD → la guía quedaba imposible de
--     corregir (reporte del usuario: «no me deja modificar la guía»).
--   · Tránsito solo permite AÑADIR envíos: una fila fantasma sin envíos
--     jamás podría resolverse desde el módulo donde se ve flotando.
--
-- ESTA RPC da el camino DIRECTO de regularización (puente Tránsito→Recepción):
--   ELIMINA UNA SOLA fila de recepcion_registros bajo TODAS estas reglas:
--     1. El usuario debe tener `recepcion.eliminar` (misma función
--        `tiene_permiso` que usan las políticas RLS — cero deriva).
--     2. La fila NO debe tener NINGÚN envío de Tránsito (si ya se trasladó
--        stock a Racks/Piso, la fila NO se toca: primero se revierte el
--        traslado; borrarla dejaría stock huérfano sin trazabilidad).
--     3. Lock por fila (mismo salt 7771 que transito_registrar_envio): un
--        envío concurrente sobre la MISMA fila se serializa — la carrera
--        "regularizo mientras otro transfiere" es imposible.
--     4. DELETE honesto con RETURNING: si la BD no borró exactamente 1
--        fila, la RPC falla (nunca un éxito fingido).
--   Devuelve el SNAPSHOT completo de lo eliminado (quién, cuándo, motivo,
--   guía, artículo, cantidad, lote, paleta, dueño original) para que la UI
--   lo muestre y quede evidencia en la respuesta.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.recepcion_regularizar_fila(p_fila_id uuid, p_motivo text default '')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row      public.recepcion_registros%rowtype;
  v_envios   jsonb;
  v_borrada  public.recepcion_registros%rowtype;
  v_actor_id uuid := auth.uid();
  v_actor    text;
begin
  -- GUARD 0 — solo usuarios autenticados (la RPC es SECURITY DEFINER).
  if coalesce(auth.role(), '') not in ('authenticated', 'service_role') then
    raise exception 'NO_AUTORIZADO|Solo usuarios autenticados pueden regularizar filas';
  end if;

  -- GUARD 1 — permiso del CUADRO (idéntico al de las políticas DELETE de la
  -- tabla): admin siempre; override de user_permisos; defecto del rol.
  if not coalesce(public.tiene_permiso(v_actor_id, 'recepcion.eliminar'), false) then
    raise exception 'PERMISO|No tienes el permiso "Eliminar guías" (recepcion.eliminar): la regularización la hace un supervisor/administrador (o quien lo tenga concedido en Usuarios).';
  end if;

  if p_fila_id is null then
    raise exception 'FILA_REQUERIDA|Falta identificar la fila a regularizar';
  end if;

  -- GUARD 2 — lock por fila: MISMA llave que transito_registrar_envio para
  -- la misma recepcion_id. Si otro usuario está registrando un envío de
  -- esta fila en este instante, esta RPC espera; si la regularización va
  -- primero, el envío verá la fila ya borrada y fallará limpio.
  perform pg_advisory_xact_lock(hashtextextended(p_fila_id::text, 7771));

  select * into v_row from public.recepcion_registros where id = p_fila_id;
  if not found then
    raise exception 'RECEPCION_NO_EXISTE|La fila ya no existe (otro usuario la regularizó o la guía se editó). Recarga Tránsito.';
  end if;

  -- GUARD 3 — SOLO filas SIN envíos de Tránsito. Con envíos, el stock ya
  -- vive en Racks/Piso: borrar la fila lo dejaría huérfano. El camino para
  -- esas es revertir el traslado primero (política idéntica al guard del
  -- editor de Recepción).
  v_envios := coalesce(v_row.transito -> 'envios', '[]'::jsonb);
  if coalesce(jsonb_array_length(v_envios), 0) > 0 then
    raise exception 'CON_ENVIOS|Esta fila ya tiene % envío(s) de Tránsito: primero revierte el traslado en Racks/Piso/Tránsito y vuelve a regularizar (borrarla dejaría stock huérfano).',
      jsonb_array_length(v_envios);
  end if;

  -- Actor legible para el snapshot (best-effort: si el perfil no existe, no
  -- bloquea la regularización).
  select coalesce(nullif(trim(nombre), ''), correo, 'usuario ' || left(v_actor_id::text, 8))
    into v_actor
    from public.profiles where id = v_actor_id;

  -- DELETE honesto: exactamente 1 fila, con RETURNING para el snapshot.
  delete from public.recepcion_registros
  where id = p_fila_id
  returning * into v_borrada;
  if not found then
    raise exception 'BORRADO_CERO|La fila no pudo borrarse (cambió de dueño o de estado). Recarga e intenta de nuevo.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'accion', 'regularizacion',
    'fila', jsonb_build_object(
      'id',               v_borrada.id,
      'guia_id',          v_borrada.guia_id,
      'tipo_documento',   v_borrada.tipo_documento,
      'numero_documento', v_borrada.numero_documento,
      'fecha',            v_borrada.fecha,
      'codigo',           v_borrada.codigo,
      'descripcion',      v_borrada.descripcion,
      'cantidad',         v_borrada.cantidad,
      'unidad_medida',    v_borrada.unidad_medida,
      'lote',             v_borrada.lote,
      'n_paleta',         v_borrada.n_paleta,
      'owner_nombre',     v_borrada.usuario_nombre
    ),
    'regularizado_por', v_actor,
    'regularizado_id',  v_actor_id,
    'motivo',           coalesce(nullif(trim(p_motivo), ''), 'Sobrante de recepción (cantidad registrada de más)'),
    'fecha',            to_char(now() at time zone 'America/Lima', 'YYYY-MM-DD HH24:MI')
  );
end;
$function$;

-- Privilegios: el navegador (authenticated) la ejecuta; anon NUNCA.
revoke execute on function public.recepcion_regularizar_fila(uuid, text) from public, anon;
grant execute on function public.recepcion_regularizar_fila(uuid, text) to authenticated;

comment on function public.recepcion_regularizar_fila(uuid, text) is
  'Regularización T173-00004274: elimina UNA fila de recepcion_registros sin envíos de Tránsito. Guard: tiene_permiso(recepcion.eliminar) + advisory lock (salt 7771) + DELETE honesto con snapshot de auditoría en la respuesta.';
