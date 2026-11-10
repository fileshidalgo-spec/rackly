-- ═══════════════════════════════════════════════════════════════════
-- RACKLY · Migración 20261110 — ALMACÉN REPUESTOS · UBICACIONES 2 SECTORES
--
-- Reconstruye el layout físico del almacén REPUESTOS según el Excel
-- "LAYOUT REPUESTOS.xlsx" (hojas UBICACION RACKS + UBICACIÓN ZONA):
--
--   SECTOR RACKS (1 773 posiciones) — R01..R36:
--     · Piso 1 (R01..R18):  nivel 0 = 1 (piso/bajo rack), N1=5, N2=17,
--       N3=17, N4=5            → 810 (792 en niveles 1-4 + 18 en N0)
--     · Piso 2 (R19..R36):     → 963 (N1=69, N2=275, N3=275, N4=275, N5=69)
--   SECTOR ZONAS (96 posiciones):
--     · A, B, C, D             16 c/u · piso 3 (tercer piso)   → 64
--     · CONTENEDOR N° 3        20     · piso 1                 → 20
--     · PRE-PICKING            4      · piso 1 (tipo prepicking) → 4
--     · RECEPCIÓN              8      · piso 1                 → 8
--
-- CORRECCIONES AL EXCEL (documentadas y validadas contra los encabezados
-- de la hoja LAYAOUT, que cuadran EXACTOS con esta versión):
--   · R29 nivel 4 = 12 posiciones (la hoja UBICACION RACKS lo duplica con
--     11+11; el dibujo LAYAOUT muestra 01..12 y el total del nivel 4 del
--     piso 2 (275) exige 12).
--   · R30 existe (3/12/12/12/3): falta en la hoja UBICACION RACKS pero
--     está completo en el dibujo LAYAOUT; sin él el piso 2 no cierra 963.
--   · Hoja UBICACIÓN ZONA: 96 filas exactas (A/B/C/D 16, CN3 20,
--     PRE-PICKING 4, RECEPCIÓN 8) — sin correcciones.
--
-- CÓDIGOS (fiel a las etiquetas del Excel, cortos para QR):
--   racks  → R{rack 2dig}-{nivel 2dig}-{posición 2dig}  ej. R01-02-17
--   zonas  → {prefijo}-{posición 2dig}  ej. A-01 · CN3-07 · PP-02 · REC-08
--
-- LIMPIEZA PREVIA (guardada: SOLO se ejecuta si todo el historial de
-- movimientos/stock/RAL es residuo E2E; con operación real real ABORTA):
--   · rep_movimientos (5 filas E2E-FILTRO-001)
--   · rep_stock (1 fila E2E) · rep_ral 'RAL-E2E-%' · rep_articulos 'E2E-%'
--   · rep_ubicaciones (3 posiciones borrador → cascada rep_loncheras)
-- SE CONSERVAN: rep_recepciones + rep_recepcion_lineas (2 líneas ZIPA
-- en_transito sin ubicación — Tránsito las ubicará en las loncheras nuevas).
--
-- ESQUEMA: rep_ubicaciones gana SECTOR ('racks'|'zonas'), RACK (1..36, solo
-- sector racks) y ZONA (nombre de zona, solo sector zonas); se sustituye la
-- unique (tipo,piso,nivel,secuencia) — colisiona entre racks — por una
-- unique funcional (sector, rack, zona, nivel, secuencia). El tipo se
-- conserva para no romper RPCs/UI: racks → 'rack' (loncheras A+B por el
-- trigger), PRE-PICKING → 'prepicking', resto de zonas → 'zona'.
-- ═══════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 0) GUARD: aborta si hay datos de operación real (solo residuo E2E)
-- ────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from rep_movimientos where codigo not like 'E2E-%') then
    raise exception 'GUARD: rep_movimientos tiene movimientos NO E2E — revisar antes de reconstruir ubicaciones';
  end if;
  if exists (
    select 1 from rep_stock s join rep_articulos a on a.id = s.articulo_id
    where a.codigo not like 'E2E-%'
  ) then
    raise exception 'GUARD: rep_stock tiene stock NO E2E — revisar antes de reconstruir ubicaciones';
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────
-- 1) Limpieza del residuo E2E (orden por dependencias de FK)
-- ────────────────────────────────────────────────────────────────────
delete from rep_movimientos;                               -- 5 filas E2E (RESTRICT hacia ubicaciones)
delete from rep_stock;                                     -- 1 fila E2E
delete from rep_ral where numero like 'RAL-E2E-%';         -- cascada rep_ral_detalle
delete from rep_articulos where codigo like 'E2E-%';       -- catálogo de prueba

-- ────────────────────────────────────────────────────────────────────
-- 2) Esquema: 3 columnas nuevas (el índice único se crea en el paso 4,
--    DESPUÉS de borrar las posiciones borrador que colisionarían)
-- ────────────────────────────────────────────────────────────────────
alter table rep_ubicaciones
  add column if not exists sector text not null default 'racks';
alter table rep_ubicaciones
  add column if not exists rack integer;
alter table rep_ubicaciones
  add column if not exists zona text not null default '';

alter table rep_ubicaciones
  drop constraint if exists rep_ubicaciones_tipo_piso_nivel_secuencia_key;

-- ────────────────────────────────────────────────────────────────────
-- 3) Borrar las posiciones borrador (cascada rep_loncheras)
-- ────────────────────────────────────────────────────────────────────
delete from rep_ubicaciones;

-- ────────────────────────────────────────────────────────────────────
-- 3b) Constraints e índices (sin filas, no hay colisión)
-- ────────────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────────────
-- 4) SECTOR RACKS — R01..R36 según el Excel (con R30 y R29-N4 corregidos)
--    El trigger rep_crear_loncheras crea A+B por fila (tipo 'rack').
-- ────────────────────────────────────────────────────────────────────

-- Sector coherente: racks con número de rack y sin zona; zonas al revés.
alter table rep_ubicaciones
  add constraint rep_ubicaciones_sector_check
  check (sector in ('racks', 'zonas'));
alter table rep_ubicaciones
  add constraint rep_ubicaciones_sector_rack_zona_check
  check (
    (sector = 'racks' and rack between 1 and 36 and zona = '')
    or (sector = 'zonas' and rack is null and zona <> '')
  );

-- Unicidad de la posición física (sustituye a la de 4 columnas, que
-- colisionaba entre racks del mismo nivel/posición).
create unique index if not exists uq_rep_ubicaciones_posicion
  on rep_ubicaciones (sector, coalesce(rack, 0), zona, nivel, secuencia);

-- Índices de lectura del mapa (orden por sector → rack/zona → nivel → pos)
create index if not exists idx_rep_ubicaciones_racks
  on rep_ubicaciones (sector, rack, nivel, secuencia);
create index if not exists idx_rep_ubicaciones_zonas
  on rep_ubicaciones (sector, zona, secuencia);
with pat(rack, nivel, npos) as (
  -- Piso 1: R01..R18 → N0=1, N1=5, N2=17, N3=17, N4=5
  select r.rack, n.nivel, n.npos
  from (values (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15),(16),(17),(18)) r(rack)
  cross join (values (0,1),(1,5),(2,17),(3,17),(4,5)) n(nivel,npos)
  union all
  -- R19 (5 niveles, ancho 19 en 2-4)
  select 19, n.nivel, n.npos
  from (values (1,5),(2,19),(3,19),(4,19),(5,5)) n(nivel,npos)
  union all
  -- R20..R28 y R31..R35 (patrón estándar piso 2)
  select r.rack, n.nivel, n.npos
  from (values (20),(21),(22),(23),(24),(25),(26),(27),(28),(31),(32),(33),(34),(35)) r(rack)
  cross join (values (1,4),(2,16),(3,16),(4,16),(5,4)) n(nivel,npos)
  union all
  -- R29 y R30 (ancho 12 en 2-4; R30 existía solo en el dibujo LAYAOUT)
  select r.rack, n.nivel, n.npos
  from (values (29),(30)) r(rack)
  cross join (values (1,3),(2,12),(3,12),(4,12),(5,3)) n(nivel,npos)
  union all
  -- R36 (compacto)
  select 36, n.nivel, n.npos
  from (values (1,2),(2,8),(3,8),(4,8),(5,2)) n(nivel,npos)
)
insert into rep_ubicaciones
  (sector, tipo, rack, zona, piso, nivel, secuencia, codigo, nota, activo)
select
  'racks',
  'rack',
  p.rack,
  '',
  case when p.rack <= 18 then 1 else 2 end,
  p.nivel,
  gs.pos,
  'R' || lpad(p.rack::text, 2, '0') || '-' || lpad(p.nivel::text, 2, '0') || '-' || lpad(gs.pos::text, 2, '0'),
  case when p.rack <= 18 then 'Primer piso' else 'Segundo piso' end,
  true
from pat p
cross join lateral generate_series(1, p.npos) as gs(pos);

-- ────────────────────────────────────────────────────────────────────
-- 5) SECTOR ZONAS — hoja UBICACIÓN ZONA (96 posiciones, 1 lonchera A)
-- ────────────────────────────────────────────────────────────────────
insert into rep_ubicaciones
  (sector, tipo, rack, zona, piso, nivel, secuencia, codigo, nota, activo)
select
  'zonas',
  case z.zona when 'PRE-PICKING' then 'prepicking' else 'zona' end,
  null,
  z.zona,
  z.piso,
  1,
  gs.pos,
  z.prefijo || '-' || lpad(gs.pos::text, 2, '0'),
  z.nota,
  true
from (values
  ('A',            'A',   16, 3, 'Zona A · tercer piso'),
  ('B',            'B',   16, 3, 'Zona B · tercer piso'),
  ('C',            'C',   16, 3, 'Zona C · tercer piso'),
  ('D',            'D',   16, 3, 'Zona D · tercer piso'),
  ('CONTENEDOR N° 3', 'CN3', 20, 1, 'Contenedor N° 3'),
  ('PRE-PICKING',  'PP',   4, 1, 'Pre-picking · salida del día'),
  ('RECEPCIÓN',    'REC',  8, 1, 'Zona de recepción')
) z(zona, prefijo, npos, piso, nota)
cross join lateral generate_series(1, z.npos) as gs(pos);

-- ────────────────────────────────────────────────────────────────────
-- 6) VALIDACIÓN DURA — aborta si los totales no cierran con el Excel
-- ────────────────────────────────────────────────────────────────────
do $$
declare
  n int; nlon int;
begin
  -- Racks: total 1773 · piso 1: 18/90/306/306/90 · piso 2: 69/275/275/275/69
  select count(*) into n from rep_ubicaciones where sector = 'racks';
  if n <> 1773 then raise exception 'RACKS: esperado 1773, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 1 and nivel = 0;
  if n <> 18 then raise exception 'P1 N0: esperado 18, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 1 and nivel = 1;
  if n <> 90 then raise exception 'P1 N1: esperado 90, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 1 and nivel = 2;
  if n <> 306 then raise exception 'P1 N2: esperado 306, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 1 and nivel = 3;
  if n <> 306 then raise exception 'P1 N3: esperado 306, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 1 and nivel = 4;
  if n <> 90 then raise exception 'P1 N4: esperado 90, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 2 and nivel = 1;
  if n <> 69 then raise exception 'P2 N1: esperado 69, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 2 and nivel = 2;
  if n <> 275 then raise exception 'P2 N2: esperado 275, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 2 and nivel = 3;
  if n <> 275 then raise exception 'P2 N3: esperado 275, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 2 and nivel = 4;
  if n <> 275 then raise exception 'P2 N4: esperado 275, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'racks' and piso = 2 and nivel = 5;
  if n <> 69 then raise exception 'P2 N5: esperado 69, hay %', n; end if;

  -- Zonas: 96 · A/B/C/D 16 · CN3 20 · PP 4 · REC 8
  select count(*) into n from rep_ubicaciones where sector = 'zonas';
  if n <> 96 then raise exception 'ZONAS: esperado 96, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'zonas' and zona = 'A';
  if n <> 16 then raise exception 'ZONA A: esperado 16, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'zonas' and zona = 'B';
  if n <> 16 then raise exception 'ZONA B: esperado 16, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'zonas' and zona = 'C';
  if n <> 16 then raise exception 'ZONA C: esperado 16, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'zonas' and zona = 'D';
  if n <> 16 then raise exception 'ZONA D: esperado 16, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'zonas' and zona = 'CONTENEDOR N° 3';
  if n <> 20 then raise exception 'CONTENEDOR N° 3: esperado 20, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'zonas' and zona = 'PRE-PICKING';
  if n <> 4 then raise exception 'PRE-PICKING: esperado 4, hay %', n; end if;
  select count(*) into n from rep_ubicaciones where sector = 'zonas' and zona = 'RECEPCIÓN';
  if n <> 8 then raise exception 'RECEPCIÓN: esperado 8, hay %', n; end if;

  -- Duplicados de código (defensa extra; UNIQUE ya lo garantiza)
  select count(*) into n from (
    select codigo from rep_ubicaciones group by codigo having count(*) > 1
  ) d;
  if n <> 0 then raise exception 'CODIGOS duplicados: %', n; end if;

  -- Loncheras creadas por el trigger: racks A+B (3546) · zonas A (96)
  select count(*) into nlon from rep_loncheras;
  if nlon <> 1773 * 2 + 96 then
    raise exception 'LONCHERAS: esperado 3642, hay %', nlon;
  end if;

  -- Las líneas de recepción en tránsito siguen intactas y sin ubicación
  select count(*) into n from rep_recepcion_lineas where estado = 'en_transito';
  if n <> 2 then
    raise exception 'LINEAS en_transito: esperado 2, hay % (¿se tocó recepción?)', n;
  end if;
end $$;

analyze rep_ubicaciones;
analyze rep_loncheras;
