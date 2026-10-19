#!/usr/bin/env node
/**
 * RACKLY — Aplica una migración SQL vía Supabase Management API.
 * Uso: node scripts/apply_sql_mapi.js <ruta.sql>
 */
const fs = require('fs');

const SUPABASE_PROJECT_REF = 'owjryvcrhpmgtkkdcrkm';
const MAPI_TOKEN = process.env.SUPABASE_MAPI_TOKEN;
if (!MAPI_TOKEN) { console.error('Falta SUPABASE_MAPI_TOKEN en el entorno.'); process.exit(1); }

const sqlFile = process.argv[2];
if (!sqlFile) { console.error('Uso: node scripts/apply_sql_mapi.js <ruta.sql>'); process.exit(1); }
const sql = fs.readFileSync(sqlFile, 'utf-8');

async function main() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MAPI_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`✗ HTTP ${res.status}: ${body.slice(0, 800)}`);
    process.exit(1);
  }
  console.log('✓ SQL aplicado.');
  console.log(body.slice(0, 400) || '(sin filas)');
}

main().catch((e) => { console.error(e); process.exit(1); });
