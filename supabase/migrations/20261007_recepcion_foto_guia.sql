-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · Migración 20261007b — Recepción: registro con foto de guía
--
-- Extiende recepcion_registros con los datos que se recopilan al
-- fotografiar una guía de remisión:
--   unidad_medida, lote, fecha_produccion, fecha_vencimiento, placa
--   y foto_url (imagen de la guía en Storage, bucket recepcion-guias).
--
-- REGLAS:
--   · 100% ADITIVA: solo ADD COLUMN con DEFAULT (los registros y las
--     consultas existentes de Racks/Piso/Atención/Usuarios no cambian).
--   · RLS ya habilitado en la tabla; las columnas heredan las políticas.
--   · El bucket de fotos se crea por la Storage API (no por SQL).
-- ═══════════════════════════════════════════════════════════════════

alter table public.recepcion_registros
  add column if not exists unidad_medida    text not null default '',
  add column if not exists lote             text not null default '',
  add column if not exists fecha_produccion date,
  add column if not exists fecha_vencimiento date,
  add column if not exists placa            text not null default '',
  add column if not exists foto_url         text;

comment on column public.recepcion_registros.unidad_medida is
  'Unidad de medida del articulo (KGM, MILL, UND...).';
comment on column public.recepcion_registros.foto_url is
  'URL publica de la foto de la guia en Storage (bucket recepcion-guias).';
