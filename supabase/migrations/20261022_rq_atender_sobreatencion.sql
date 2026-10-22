-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · rq_atender_item v2 — SOBREATENCIÓN PERMITIDA (2026-10-22)
-- ═══════════════════════════════════════════════════════════════════
-- El usuario pidió (módulo Atención): "puede ser más pero nunca menos".
-- Ejemplo real: tapas — se piden 120 mil pero el formato por paleta trae
-- 123 mil; la cantidad registrada es la que físicamente sale (123 mil) y
-- el material queda COMPLETO al alcanzar o superar lo requerido.
--
-- Cambio ÚNICO vs v1: se elimina el tope `v_nuevo > cantidad → exception`.
-- Se conserva intacto:
--   · validación cantidad > 0,
--   · actualización atómica de la fila,
--   · sello atendido_en al alcanzar/superar lo requerido,
--   · recálculo del estado del encabezado en la misma transacción.
-- Firma y permisos sin cambios (CREATE OR REPLACE, mismas types).
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rq_atender_item(p_item_id uuid, p_cantidad numeric, p_usuario text)
RETURNS json
LANGUAGE plpgsql
AS $function$
declare
  v_item rq_atencion_items%ROWTYPE;
  v_nuevo numeric;
  v_pendientes integer;
begin
  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad a atender debe ser mayor que cero';
  end if;

  select * into v_item from rq_atencion_items where id = p_item_id;
  if not found then
    raise exception 'Artículo no encontrado (puede haber sido eliminado)';
  end if;

  -- v2: SIN tope superior. La salida física puede exceder lo requerido
  -- (formato por paleta). "Puede ser más, nunca menos": el estado pasa a
  -- 'Atendido' cuando la suma alcanzó o superó la cantidad pedida.
  v_nuevo := v_item.cantidad_atendida + p_cantidad;

  update rq_atencion_items set
    cantidad_atendida = v_nuevo,
    usuario_atencion = coalesce(nullif(p_usuario, ''), usuario_atencion),
    atendido_en = case when v_nuevo >= v_item.cantidad then now() else null end
  where id = p_item_id
  returning * into v_item;

  select count(*) into v_pendientes
    from rq_atencion_items
    where rq_id = v_item.rq_id and cantidad_atendida < cantidad;

  update rq_atenciones set
    estado = case when v_pendientes = 0 then 'Atendido' else 'En proceso' end
  where id = v_item.rq_id;

  return to_json(v_item);
end $function$;
