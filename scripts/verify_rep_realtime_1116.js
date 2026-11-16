#!/usr/bin/env node
/**
 * RACKLY — Verificación de la publicación supabase_realtime para
 * rep_recepcion_lineas (migración 20261116_rep_transito_qr).
 * SOLO LECTURA. Uso: SUPABASE_MAPI_TOKEN=… node scripts/verify_rep_realtime_1116.js
 */
const SUPABASE_PROJECT_REF = 'owjryvcrhpmgtkkdcrkm';
const MAPI_TOKEN = process.env.SUPABASE_MAPI_TOKEN;
if (!MAPI_TOKEN) { console.error('Falta SUPABASE_MAPI_TOKEN en el entorno.'); process.exit(1); }

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MAPI_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  return JSON.parse(body || '[]');
}

async function main() {
  const pub = await query(
    `select schemaname, tablename, pubname from pg_publication_tables
     where pubname='supabase_realtime' order by tablename;`
  );
  console.log('== Tablas en supabase_realtime ==');
  for (const r of pub) console.log(`  · ${r.tablename} (${r.schemaname})`);
  const ok = pub.some((r) => r.tablename === 'rep_recepcion_lineas');
  console.log(ok
    ? '✓ rep_recepcion_lineas PUBLICADA — realtime del Tránsito de Repuestos activo'
    : '✗ rep_recepcion_lineas NO está en la publicación');
  const rls = await query(
    `select c.relname, c.relrowsecurity, c.relreplident
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='rep_recepcion_lineas';`
  );
  const t = rls[0];
  console.log(`  RLS activo: ${t?.relrowsecurity} · replica identity: ${t?.relreplident} (default=PK: suficiente para UPDATE/DELETE)`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
