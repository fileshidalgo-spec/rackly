/** Verificación post-REVOKE (read-only): grants y prueba E2E anon. */
const REF='owjryvcrhpmgtkkdcrkm', T=process.env.SUPABASE_MAPI_TOKEN;
(async()=>{
  // 1) grants restantes
  const r=await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`,{method:'POST',
    headers:{Authorization:`Bearer ${T}`,'Content-Type':'application/json'},
    body:JSON.stringify({query:`select proname, proacl::text as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('rackly_backfill_lote_fefo','rackly_rebalance_lotes_fefo')`})});
  for(const x of await r.json()) console.log('ACL', x.proname, '→', x.acl);
  // 2) prueba E2E: llamada anon con la anon key pública
  const ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93anJ5dmNyaHBtZ3Rra2RjcmttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxOTEwODUsImV4cCI6MjA5NDc2NzA4NX0.txneI_FZQhC782QYCW3jQ8WEIif_0xUZR-6esqy0aTg';
  const e=await fetch(`https://owjryvcrhpmgtkkdcrkm.supabase.co/rest/v1/rpc/rackly_rebalance_lotes_fefo`,{method:'POST',
    headers:{apikey:ANON,Authorization:`Bearer ${ANON}`,'Content-Type':'application/json'},body:'{}'});
  console.log('E2E anon → HTTP', e.status, (await e.text()).slice(0,120));
})();
