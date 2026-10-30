-- ═══════════════════════════════════════════════════════════════════
-- RACKLY — Devoluciones de línea en Recepción (trace 1a18f196e42d8cc1).
--
-- Decisión de estructura (paso 4 del método, sin conflictos paso 5):
--   UNA tabla recepcion_registros con la columna `tipo_recepcion`:
--     · 'guia'       → recepción de guías (DEFAULT — compatibilidad total
--                      con las 2.624 filas existentes: la BD las rellena).
--     · 'devolucion' → devoluciones de línea (nueva vía de recepción).
--   Por qué NO una tabla nueva: transito_registrar_envio (RPC atómica que
--   marca recepcion_registros.transito), el QR único por rótulo
--   (recepcionId = fila), las 10 políticas RLS, el índice único uuid_sync
--   y recepcion_regularizar_fila siguen funcionando para devoluciones SIN
--   tocar nada más — cero duplicación de lógica, cero riesgo de cruces.
--
--   CHECK: la BD rechaza valores fuera del dominio (tipografía segura).
--   Índice compuesto: los DOS listados (guías y devoluciones) consultan
--   por tipo + fecha DESC + created_at DESC — un solo índice sirve a ambos.
-- ═══════════════════════════════════════════════════════════════════

alter table public.recepcion_registros
  add column if not exists tipo_recepcion text not null default 'guia';

-- Dominio cerrado: filas fuera de {guia, devolucion} no pueden existir.
-- DROP IF EXISTS primero: la migración es re-ejecutable (idempotente).
alter table public.recepcion_registros
  drop constraint if exists recepcion_tipo_recepcion_chk;
alter table public.recepcion_registros
  add constraint recepcion_tipo_recepcion_chk
  check (tipo_recepcion in ('guia', 'devolucion'));

-- Listado por pestaña: tipo + fecha DESC + created_at DESC (mismo orden
-- que listarRecepciones). Los listados de guías y devoluciones quedan
-- indexados sin duplicar índices de fecha existentes.
create index if not exists idx_recepcion_tipo_fecha
  on public.recepcion_registros (tipo_recepcion, fecha desc, created_at desc);

-- Comentario de columna (autodocumentación de la BD).
comment on column public.recepcion_registros.tipo_recepcion is
  'Tipo de recepción: ''guia'' (recepción de guías, default) o ''devolucion'' (devoluciones de línea).';
