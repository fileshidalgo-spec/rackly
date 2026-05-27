#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * Script de despliegue: Crear funcion ocupacion_celdas() en Supabase
 * ═══════════════════════════════════════════════════════════════
 *
 * USO:
 *   node scripts/deploy-ocupacion-rpc.js [DB_PASSWORD]
 *
 * Si no pasas la contrasena, se leera de SUPABASE_DB_PASSWORD env var.
 *
 * La conexion usa el pooler de Supabase (port 6543).
 * Si no funciona, usa la conexion directa (port 5432).
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const PROJECT_REF = 'owjryvcrhpmgtkkdcrkm';
const REGIONS = [
  'aws-0-us-east-1.pooler.supabase.com',
  'aws-0-us-west-1.pooler.supabase.com',
  'aws-0-sa-east-1.pooler.supabase.com',
  'aws-0-eu-west-1.pooler.supabase.com',
  'aws-0-ap-southeast-1.pooler.supabase.com',
];

const password = process.argv[2] || process.env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error('Se requiere la contrasena de la base de datos.');
  console.error('   USO: node scripts/deploy-ocupacion-rpc.js TU_CONTRASENA');
  console.error('   O:   SUPABASE_DB_PASSWORD=tu_pass node scripts/deploy-ocupacion-rpc.js');
  process.exit(1);
}

const sqlFile = path.join(__dirname, '..', 'supabase', 'migrations', '20260527_ocupacion_celdas.sql');
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
  console.log('Desplegando funcion ocupacion_celdas() en Supabase...');

  let client = null;
  for (const region of REGIONS) {
    const host = `${region}`;
    try {
      console.log(`   Probando ${host}...`);
      client = await tryConnect(host);
      console.log(`   Conectado a ${host}`);
      break;
    } catch {
      console.log(`   No disponible`);
    }
  }

  if (!client) {
    // Intentar conexion directa
    const directHost = `db.${PROJECT_REF}.supabase.co`;
    try {
      console.log(`   Probando conexion directa ${directHost}:5432...`);
      client = new Client({
        host: directHost,
        port: 5432,
        database: 'postgres',
        user: `postgres`,
        password,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
      });
      await client.connect();
      console.log(`   Conectado a ${directHost}`);
    } catch (e) {
      console.error('No se pudo conectar a ninguna region.');
      console.error('   Verifica la contrasena y que la IP tenga acceso.');
      process.exit(1);
    }
  }

  try {
    await client.query(sql);
    console.log('Funcion ocupacion_celdas() creada exitosamente.');
  } catch (e) {
    console.error('Error al crear la funcion:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
