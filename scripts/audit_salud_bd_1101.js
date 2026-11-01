#!/usr/bin/env node
/**
 * RACKLY — Auditoría integral 2026-11-01 (trace 1a1976a1b9d39725): salud de BD.
 * Read-only: NO modifica datos. Uso: SUPABASE_MAPI_TOKEN=... node scripts/audit_salud_bd_1101.js
 */
const REF = 'owjryvcrhpmgtkkdcrkm';
const TOKEN = process.env.SUPABASE_MAPI_TOKEN;
if (!TOKEN) { console.error('Falta SUPABASE_MAPI_TOKEN'); process.exit(1); }

async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body || '[]');
}

const CHECKS = [
  ['RLS activo (debe ser TODAS las tablas públicas)',
   `select count(*) filter (where relrowsecurity) as con_rls, count(*) as total
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname not like 'user_permisos%'`],
  ['Políticas DELETE por rol (deben tener contraparte honesta en app)',
   `select tablename, policyname from pg_policies
    where schemaname='public' and cmd='DELETE' and policyname like '%auth%' limit 25`],
  ['Recepción: filas por tipo_recepcion',
   `select tipo_recepcion, count(*) from recepcion_registros group by 1`],
  ['Recepción: filas sin guia_id (huérfanas de documento)',
   `select count(*) as sin_guia_id from recepcion_registros where guia_id is null or guia_id=''`],
  ['recepcion: uuid_sync duplicados (idempotencia M-1)',
   `select uuid_sync, count(*) from recepcion_registros where uuid_sync is not null group by 1 having count(*)>1 limit 5`],
  ['RQ: items huérfanos (sin encabezado)',
   `select count(*) as huerfanos from rq_atencion_items i left join rq_atenciones r on r.id=i.rq_id where r.id is null`],
  ['RAL: items huérfanos',
   `select count(*) as huerfanos from ral_items i left join rals r on r.id=i.ral_id where r.id is null`],
  ['Piso: movimiento_detalles huérfanos',
   `select count(*) as huerfanos from piso_movimiento_detalles d left join piso_movimientos m on m.id=d.movimiento_id where m.id is null`],
  ['Estados recepción inconsistentes (valores fuera del catálogo)',
   `select estado, count(*) from recepcion_registros group by 1 order by 2 desc`],
  ['Estados RQ fuera de la regla canónica',
   `select estado, count(*) from rq_atenciones group by 1`],
  ['Catálogo: códigos duplicados',
   `select codigo, count(*) from catalogo group by 1 having count(*)>1 limit 5`],
  ['Catálogo: total filas',
   `select count(*) as total from catalogo`],
  ['Tránsito: envíos con recepcion inexistente',
   `select count(*) as huerfanos from transito_envios e left join recepcion_registros r on r.id=e.recepcion_id where r.id is null`],
  ['user_permisos: overrides activos',
   `select count(*) as overrides from user_permisos`],
  ['RPCs SECURITY DEFINER con guard tiene_permiso',
   `select count(*) as con_guard from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef and p.prosrc like '%tiene_permiso%'`],
  ['RPCs SECURITY DEFINER totales',
   `select count(*) as total from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef`],
];

(async () => {
  let fallos = 0;
  for (const [nombre, sql] of CHECKS) {
    try {
      const rows = await q(sql);
      console.log(`◆ ${nombre}`);
      console.log(`  ${JSON.stringify(rows).slice(0, 400)}`);
    } catch (e) {
      fallos++;
      console.log(`✗ ${nombre}: ${e.message}`);
    }
  }
  console.log(fallos === 0 ? '\n== TODOS LOS CHECKS EJECUTADOS ==' : `\n== ${fallos} checks con error ==`);
})();
