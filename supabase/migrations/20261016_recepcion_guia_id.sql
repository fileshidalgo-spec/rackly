-- ═══════════════════════════════════════════════════════════════════
-- RACKLY — Recepción · Identidad INQUEBRANTABLE de guía (guia_id)
-- 2026-10-16 · Módulo Recepción
--
-- Problema (reporte de usuarios + auditoría de código):
--   La identidad de una guía era SOLO (tipo_documento, numero_documento)
--   — o (fecha, tipo, proveedor) si no tenía número — por lo que:
--     a) Guías distintas que compartan Nº (re-registro, OCR equivocado,
--        número reutilizado en otra fecha) se FUSIONABAN: imprimir,
--        editar, cambiar estado y eliminar operaban sobre TODAS a la vez
--        → "al imprimir salen artículos de otras guías" y riesgo real de
--        pérdida de datos al editar/eliminar.
--     b) Las filas de UNA misma recepción no tenían vínculo fuerte entre
--        sí (todo dependía de lo digitado por el usuario).
--
-- Solución:
--   · Columna guia_id (uuid): TODAS las filas de UNA recepción comparten
--     UN uuid generado al registrar. Imprimir/editar/estado/eliminar/
--     Excel filtran por guia_id — exacto, inmutable, independiente de
--     lo digitado.
--   · Backfill idempotente: cada grupo histórico (tipo, numero, fecha,
--     proveedor) recibe UN guia_id. Mismo número en fechas distintas =
--     guías SEPARADAS (corrige también lo histórico).
--   · Las filas nuevas la reciben del app (crearRecepciones genera UN
--     uuid por registro); este backfill solo rellena las que queden
--     null (idempotente por diseño).
--
-- Riesgo para otros módulos: CERO.
--   · Solo toca recepcion_registros (Tránsito sigue anclado POR FILA vía
--     columna transito jsonb; Kardex/Piso/Usuarios no la leen).
--   · Los GRANT de tabla cubren la columna nueva automáticamente.
-- ═══════════════════════════════════════════════════════════════════

alter table public.recepcion_registros
  add column if not exists guia_id uuid;

comment on column public.recepcion_registros.guia_id is
  'Identidad de la GUÍA (documento completo): todas las filas de una misma recepción comparten este uuid. Lo genera el app al registrar (uno por lote). Imprimir/editar/estado/eliminar filtran por aquí — nunca solo por tipo+número.';

-- Índice para las consultas por guía (impresión, edición, estado, borrado).
create index if not exists idx_recepcion_guia_id
  on public.recepcion_registros (guia_id);

-- ── BACKFILL (idempotente): un uuid por grupo histórico ──────────────
-- Llave de grupo: tipo_documento + numero_documento + fecha + proveedor
-- (chr(1) como separador imposible de tipear: evita colisiones de
--  concatenación como ("AB","C") vs ("A","BC")).
with objetivo as (
  select id,
         coalesce(tipo_documento, '')   || chr(1) ||
         coalesce(numero_documento, '') || chr(1) ||
         fecha::text                    || chr(1) ||
         coalesce(proveedor, '')        as k
  from public.recepcion_registros
  where guia_id is null
),
uuids as (
  select k, gen_random_uuid() as gid
  from (select distinct k from objetivo) d
)
update public.recepcion_registros r
set guia_id = u.gid
from objetivo o
join uuids u on u.k = o.k
where r.id = o.id
  and r.guia_id is null;

-- ── VERIFICACIÓN ─────────────────────────────────────────────────────
-- Esperado: filas_sin_guia = 0 · guias_totales ≈ nº de recepciones.
-- select count(*) filter (where guia_id is null) as filas_sin_guia,
--        count(distinct guia_id)               as guias_totales,
--        count(*)                              as filas_totales
-- from public.recepcion_registros;
