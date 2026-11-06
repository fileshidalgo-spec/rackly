#!/usr/bin/env node
/**
 * RACKLY — Auditoría exhaustiva 2026-11-06 · Auto-reparación del catálogo.
 * Los códigos CON stock físico real (>0) deben existir SIEMPRE en catálogo:
 * el flujo «vaciar catálogo → importar Excel» del 2026-11-05 borró el
 * re-registro de huérfanos y dejó 33,947 u invisibles. La reparación vive en
 * catalogo.ts (reRegistrarCodigosConStock vía RPC idempotente) y se dispara
 * tras mergeCatalogo y clearCatalogo.
 * Sin red: dataClient se sustituye por un fake determinista.
 * Ejecutada por scripts/run_all_tests.sh (esbuild → node).
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
const assert = require('assert')
const { dataClient } = require('@/lib/supabase/client')
const {
  reRegistrarCodigosConStock,
  ultimoReRegistro,
  mergeCatalogo,
  clearCatalogo,
} = require('@/lib/rackly/catalogo.ts')

let ok = 0
function check(nombre, cond) {
  if (!cond) { console.error(`✗ ${nombre}`); process.exitCode = 1 }
  else { ok++; console.log(`✓ ${nombre}`) }
}

// ── Fake determinista de dataClient (from + rpc) ──
function instalarFake({ rpcFilas = null, rpcError = null } = {}) {
  const llamadas = { rpc: [], upserts: [], deletes: [], fetches: 0 }
  const client = {
    rpc(fn, args) {
      llamadas.rpc.push({ fn, args })
      return Promise.resolve({ data: rpcError ? null : (rpcFilas ?? []), error: rpcError })
    },
    from(tabla) {
      const b = {
        select() { return b },
        order() { return b },
        eq() { return b },
        neq() { return b },
        range() { llamadas.fetches++; return Promise.resolve({ data: [], error: null }) },
        upsert(payload) { llamadas.upserts.push(payload); return Promise.resolve({ data: null, error: null }) },
        delete() { llamadas.deletes.push(tabla); return b },
      }
      return b
    },
  }
  dataClient.from = client.from
  dataClient.rpc = client.rpc
  return llamadas
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1) RPC devuelve 1 fila → registrados=1, código reportado, getter expone
  let ll = instalarFake({ rpcFilas: [{ codigo: '55972 BIG COLA FIESTAS PATRIAS', stock: 23500 }] })
  let r = await reRegistrarCodigosConStock('user-1')
  await sleep(0)
  check('rpc invocada con nombre correcto', ll.rpc.length === 1 && ll.rpc[0].fn === 'catalogo_reregistrar_con_stock')
  check('p_usuario propagado', ll.rpc[0].args && ll.rpc[0].args.p_usuario === 'user-1')
  check('registrados=1 con el código de la RPC', r.registrados === 1 && r.codigos[0] === '55972 BIG COLA FIESTAS PATRIAS')
  check('ultimoReRegistro expone el mismo resultado', ultimoReRegistro().registrados === 1)

  // 2) RPC falla → resultado vacío, NO lanza (la importación nunca se pierde)
  instalarFake({ rpcError: { message: 'RPC no existe (simulado)' } })
  r = await reRegistrarCodigosConStock(null)
  check('fallo de RPC no lanza y devuelve registrados=0', r.registrados === 0 && r.codigos.length === 0)
  check('getter también refleja el fallo como 0', ultimoReRegistro().registrados === 0)

  // 3) mergeCatalogo dispara la auto-reparación al final y expone reRegistrados
  ll = instalarFake({ rpcFilas: [{ codigo: 'TRADE MARKETING', stock: 64 }, { codigo: '54108', stock: 2600 }] })
  const res = await mergeCatalogo([{ codigo: 'T0001', un: 'UN', descripcion: 'X', stock_big_magic: 1 }])
  await sleep(0)
  check('mergeCatalogo invoca la RPC de reparación', ll.rpc.some((c) => c.fn === 'catalogo_reregistrar_con_stock'))
  check('mergeCatalogo reporta reRegistrados=2', res.reRegistrados === 2)
  check('resultado de merge incluye catálogo recargado', Array.isArray(res.catalogo))

  // 4) clearCatalogo dispara la auto-reparación (el caso real del 2026-11-05)
  ll = instalarFake({ rpcFilas: [{ codigo: '2', stock: 9 }] })
  await clearCatalogo('user-2')
  await sleep(0)
  check('clearCatalogo invoca la RPC de reparación', ll.rpc.some((c) => c.fn === 'catalogo_reregistrar_con_stock'))
  check('clearCatalogo borra el catálogo (delete ejecutado)', ll.deletes.includes('catalogo'))
  check('p_usuario del clear propagado a la RPC',
    ll.rpc.find((c) => c.fn === 'catalogo_reregistrar_con_stock')?.args?.p_usuario === 'user-2')

  // 5) RPC sin filas (estado sano) → registrados=0 (idempotente)
  instalarFake({ rpcFilas: [] })
  r = await reRegistrarCodigosConStock()
  check('RPC sin pendientes → registrados=0', r.registrados === 0)

  console.log(`═══ RESULTADO: ${ok} pasados${process.exitCode ? ', FALLIDOS' : ', 0 fallidos'} ═══`)
}

main().catch((e) => { console.error(e); process.exit(1) })
