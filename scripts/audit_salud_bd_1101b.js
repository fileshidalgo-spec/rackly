#!/usr/bin/env node
const REF = 'owjryvcrhpmgtkkdcrkm';
const TOKEN = process.env.SUPABASE_MAPI_TOKEN;
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
(async () => {
  const checks = [
    ['RPCs SECDEF SIN guard (muta=true exige revisión)',
     `select p.proname, (p.prosrc ~* '\\m(insert|update|delete)') as muta
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef and p.prosrc not like '%tiene_permiso%'
      order by 2 desc, 1`],
  ];
  for (const [nombre, sql] of checks) {
    try { console.log(`◆ ${nombre}\n  ${JSON.stringify(await q(sql)).slice(0, 1200)}`); }
    catch (e) { console.log(`✗ ${nombre}: ${e.message}`); }
  }
})();
