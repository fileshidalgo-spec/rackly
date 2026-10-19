#!/usr/bin/env node
/**
 * RACKLY — Verifica que las RPCs v2 de editar lote/vencimiento estén desplegadas.
 * Uso: node scripts/verify-editar-lote-v2.js
 */
const SUPABASE_PROJECT_REF = 'owjryvcrhpmgtkkdcrkm';
const MAPI_TOKEN = process.env.SUPABASE_MAPI_TOKEN;
if (!MAPI_TOKEN) { console.error('Falta SUPABASE_MAPI_TOKEN en el entorno.'); process.exit(1); }

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MAPI_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body || '[]');
}

async function main() {
  const rows = await query(`
    SELECT p.proname, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('editar_lote_vencimiento_racks','editar_lote_vencimiento_piso')
    ORDER BY p.proname;
  `);
  let ok = true;
  for (const r of rows) {
    const tieneV2 = r.args.includes('p_lote_actual') && r.args.includes('p_f_vencimiento_actual');
    console.log(`${tieneV2 ? '✓' : '✗'} ${r.proname}`);
    console.log(`   args: ${r.args}`);
    if (!tieneV2) ok = false;
  }
  if (rows.length < 2) { console.error('✗ Faltan funciones'); process.exit(1); }
  console.log(ok ? 'RPCs v2 desplegadas correctamente.' : 'RPCs SIN parámetros v2 — revisar.');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
