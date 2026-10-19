#!/usr/bin/env node
/**
 * RACKLY — Aplica la migración v2 de editar lote/vencimiento a Supabase.
 * Uso: node scripts/deploy-editar-lote-v2.js [DB_PASSWORD]
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const PROJECT_REF = 'owjryvcrhpmgtkkdcrkm';
const REGIONS = [
  'aws-0-us-east-1.pooler.supabase.com',
  'aws-0-us-west-1.pooler.supabase.com',
  'aws-0-sa-east-1.pooler.supabase.com',
];

const password = process.argv[2] || process.env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error('Se requiere la contraseña de la base de datos.');
  process.exit(1);
}

const sqlFile = path.join(__dirname, '..', 'supabase', 'migrations', '20261020_editar_lote_vencimiento_v2.sql');
const sql = fs.readFileSync(sqlFile, 'utf-8');

async function tryConnect(host) {
  const client = new Client({
    host,
    port: 6543,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  });
  await client.connect();
  return client;
}

async function main() {
  let client = null;
  for (const region of REGIONS) {
    try {
      console.log(`   Probando ${region}...`);
      client = await tryConnect(region);
      console.log(`   Conectado vía ${region}`);
      break;
    } catch (e) {
      console.log(`   Falló: ${e.message}`);
    }
  }
  if (!client) { console.error('No se pudo conectar a ninguna región.'); process.exit(1); }

  try {
    await client.query(sql);
    console.log('✓ Migración v2 aplicada (CREATE OR REPLACE × 2).');

    // Verificación: las funciones deben existir con los parámetros nuevos
    const { rows } = await client.query(`
      SELECT p.proname, pg_get_function_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('editar_lote_vencimiento_racks','editar_lote_vencimiento_piso')
      ORDER BY p.proname;
    `);
    for (const r of rows) {
      console.log(`  · ${r.proname}(${r.args})`);
      const ok = r.args.includes('p_lote_actual') && r.args.includes('p_f_vencimiento_actual');
      console.log(`    → parámetros v2 ${ok ? 'PRESENTES ✓' : 'FALTAN ✗'}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
