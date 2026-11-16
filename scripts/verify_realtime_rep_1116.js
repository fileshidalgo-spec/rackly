#!/usr/bin/env node
/**
 * RACKLY — Verificación de ENTREGA realtime para rep_recepcion_lineas
 * (migración 20261116_rep_transito_qr). Cliente supabase-js autenticado con
 * la cuenta del usuario (postgres_changes se autoriza contra RLS con el JWT
 * del socket — anon NO sirve en tablas RLS), suscrito a la tabla; luego se
 * dispara un UPDATE no-op vía MAPI y se espera el evento.
 *
 * SOLO RED DE LECTURA/NO-OP (sin cambios de datos). NO entra en
 * run_all_tests.sh (nombre verify_*, no test_*).
 * Uso: SUPABASE_MAPI_TOKEN=… node scripts/verify_realtime_rep_1116.js
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || (() => {
  const fs = require('fs')
  const t = fs.readFileSync('.env.local', 'utf8')
  return Object.fromEntries(t.trim().split('\n').map((l) => l.split('=')))[ 'NEXT_PUBLIC_SUPABASE_URL' ]
})()
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || (() => {
  const fs = require('fs')
  const t = fs.readFileSync('.env.local', 'utf8')
  return Object.fromEntries(t.trim().split('\n').map((l) => l.split('=')))[ 'NEXT_PUBLIC_SUPABASE_ANON_KEY' ]
})()

const { createClient } = require('@supabase/supabase-js')
const MAPI = process.env.SUPABASE_MAPI_TOKEN
const PROYECTO = 'owjryvcrhpmgtkkdcrkm'
const EMAIL = 'miguel.hidalgo.pe@ecaral.pe'
const PASS = 'Ajeper$2022#'

async function noOpUpdate() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROYECTO}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MAPI}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: "update public.rep_recepcion_lineas set estado='en_transito' where id = (select id from public.rep_recepcion_lineas where estado='en_transito' limit 1) returning id",
    }),
  })
  const t = await res.text()
  console.log('UPDATE no-op disparado:', t.slice(0, 80))
}

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    realtime: { params: { eventsPerSecond: 5 } },
  })
  const { error } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASS })
  if (error) { console.error('login falló:', error.message); process.exit(1) }
  console.log('✓ sesión autenticada (JWT real para autorización RLS del realtime)')

  const inicio = Date.now()
  const canal = supabase
    .channel('verify-rt-rep-1116')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rep_recepcion_lineas' }, (payload) => {
      const s = ((Date.now() - inicio) / 1000).toFixed(1)
      console.log(`✓ EVENTO RECIBIDO en ${s}s → ${payload.eventType} · fila ${payload.new?.id ?? payload.old?.id ?? '?'}`)
      console.log('  ENTREGA REALTIME CONFIRMADA — la migración funciona de punta a punta')
      process.exit(0)
    })
    .subscribe((status) => console.log('canal:', status))

  // Espera a SUBSCRIBED antes de disparar (hasta 15 s)
  let ok = false
  for (let i = 0; i < 30; i++) {
    if (canal.state === 'joined') { ok = true; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!ok) {
    console.error('✗ el canal no se unió en 15 s (¿wss bloqueado en este entorno?)')
    process.exit(2)
  }
  console.log('✓ canal unido — disparando UPDATE no-op…')
  await noOpUpdate()
  // Espera el evento hasta 30 s
  await new Promise((r) => setTimeout(r, 30000))
  console.error('✗ 30 s sin evento — entrega NO confirmada')
  process.exit(1)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
