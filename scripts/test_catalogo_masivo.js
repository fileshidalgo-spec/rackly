#!/usr/bin/env node
/**
 * RACKLY — Task 16 · Catálogo masivo (>2000 líneas): parseo con stats,
 * mergeCatalogo por lotes con dedupe + reintento + fallback fila-a-fila.
 * Sin red: dataClient se sustituye por un fake determinista.
 * Ejecutada por scripts/run_all_tests.sh (esbuild → node).
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
const assert = require('assert')
const { dataClient } = require('@/lib/supabase/client')
const {
  parseCatalogoText,
  parseCatalogoExcelRows,
  mergeCatalogo,
} = require('@/lib/rackly/catalogo.ts')

let ok = 0
function check(nombre, cond) {
  if (!cond) { console.error(`✗ ${nombre}`); process.exitCode = 1 }
  else { ok++; console.log(`✓ ${nombre}`) }
}

// ── Fake determinista de dataClient ──
function instalarFake({ fallosChunk = 0, codigosMalaSuerte = [] }) {
  const llamadas = { lotes: [], filas: [] }
  let fallosRestantes = fallosChunk
  const client = {
    from(tabla) {
      const b = {
        select() { return b },
        order() { return b },
        range() { return Promise.resolve({ data: [], error: null }) }, // fetchCatalogo final
        upsert(payload, opts) {
          if (Array.isArray(payload)) {
            llamadas.lotes.push({ tam: payload.length, opts })
            if (fallosRestantes > 0) {
              fallosRestantes--
              return Promise.resolve({ data: null, error: { message: 'network down (simulado)' } })
            }
            return Promise.resolve({ data: null, error: null })
          }
          llamadas.filas.push(payload.codigo)
          if (codigosMalaSuerte.includes(payload.codigo)) {
            return Promise.resolve({ data: null, error: { message: 'fila envenenada (simulado)' } })
          }
          return Promise.resolve({ data: null, error: null })
        },
      }
      return b
    },
  }
  dataClient.from = client.from
  return llamadas
}

function item(n) {
  return { codigo: `T${String(n).padStart(4, '0')}`, un: 'KG', descripcion: `ART ${n}`, stock_big_magic: n }
}

// ═══ 1. parseCatalogoText con stats ═══
const texto = [
  'Código\tUN\tDescripción\tStock BM', // cabecera → ignorada
  'ABC1\tKG\tAcido Citrico\t100',
  'XYZ incompleta', // 1 columna → ignorada
  'abc2\tUN\tAzucar\t50',
  '', // vacía → ni cuenta
  'ABC3\tLT\tAlcohol\t70',
  'abc4\tMT\tAlambre\t90',
].join('\n')
const st = { leidas: 0, validas: 0, ignoradas: 0 }
const itemsTexto = parseCatalogoText(texto, st)
check('parse texto: 4 items válidos', itemsTexto.length === 4)
check('parse texto: stats leidas=6', st.leidas === 6)
check('parse texto: stats validas=4', st.validas === 4)
check('parse texto: stats ignoradas=2', st.ignoradas === 2)
check('parse texto: códigos normalizados a UPPER', itemsTexto.every((i) => i.codigo === i.codigo.toUpperCase()))
// Backward compat: sin stats no explota
check('parse texto: sin stats (backward compat)', parseCatalogoText(texto).length === 4)

// ═══ 2. parseCatalogoExcelRows con stats ═══
const filas = [
  { CODIGO: 'CODIGO', DESCRIPCION: 'DESCRIPCION', UN: 'UN', 'STOCK BIG MAGIC': 'BM' }, // cabecera
  { CODIGO: '101', DESCRIPCION: 'Filtro de aire', UN: 'UN', 'STOCK BIG MAGIC': '12.5' },
  { CODIGO: '102', DESCRIPCION: 'Aceite', UN: 'LT', 'STOCK BIG MAGIC': '' },
  { DESCRIPCION: 'sin codigo', UN: 'UN' }, // ignorada
  { codigo: '103', descripcion: 'Grasa', un: 'KG' },
]
const st2 = { leidas: 0, validas: 0, ignoradas: 0 }
const itemsExcel = parseCatalogoExcelRows(filas, st2)
check('parse excel: 3 items válidos', itemsExcel.length === 3)
check('parse excel: stats leidas=5', st2.leidas === 5)
check('parse excel: stats ignoradas=2', st2.ignoradas === 2)
check('parse excel: 101→"101", stock 12.5', itemsExcel[0].codigo === '101' && itemsExcel[0].stock_big_magic === 12.5)

// ═══ 3-6. mergeCatalogo: lotes + dedupe + progreso + reintento + fallback ═══
async function main() {
  // ── 3. lotes de 500 + dedupe + progreso ──
  {
    const llamadas = instalarFake({})
    const archivo = []
    for (let i = 0; i < 1203; i++) archivo.push(item(i))
    archivo.push(item(0), item(0), item(7)) // 3 duplicadas intra-archivo
    const prog = []
    const out = await mergeCatalogo(archivo, (p) => prog.push(p))
    check('merge 1206 filas → 1203 únicos cargados', out.cargados === 1203 && out.errores.length === 0)
    check('merge: 3 lotes [500,500,203]', JSON.stringify(llamadas.lotes.map((l) => l.tam)) === '[500,500,203]')
    check('merge: onConflict codigo en todos los lotes', llamadas.lotes.every((l) => l.opts && l.opts.onConflict === 'codigo'))
    check('merge: dedupe — se envían exactamente 1203 filas', llamadas.lotes.reduce((a, l) => a + l.tam, 0) === 1203)
    check('merge: progreso 3 avisos', prog.length === 3)
    check('merge: progreso final {cargados:1203, lote:3/3}',
      prog[2].cargados === 1203 && prog[2].total === 1203 && prog[2].lote === 3 && prog[2].totalLotes === 3)
  }

  // ── 4. reintento por lote (fallo transitorio) ──
  {
    const llamadas = instalarFake({ fallosChunk: 1 })
    const archivo = [item(1), item(2), item(3)]
    const prog = []
    const out = await mergeCatalogo(archivo, (p) => prog.push(p))
    check('merge reintento: lote caído se recupera al 2º intento', out.cargados === 3 && out.errores.length === 0)
    check('merge reintento: 2 intentos del lote (1º falla, 2º OK) + 0 filas sueltas', llamadas.lotes.length === 2 && llamadas.filas.length === 0)
    check('merge reintento: progreso reporta cargados=3', prog[0].cargados === 3)
  }

  // ── 5. fallback fila-a-fila tras 2 fallos del lote ──
  {
    const llamadas = instalarFake({ fallosChunk: 2 })
    const archivo = [item(1), item(2), item(3), item(4)]
    const out = await mergeCatalogo(archivo)
    check('merge fallback: filas se salvan una a una', out.cargados === 4 && out.errores.length === 0)
    check('merge fallback: 2 intentos de lote + 4 filas sueltas', llamadas.lotes.length === 2 && llamadas.filas.length === 4)
  }

  // ── 6. fila envenenada aislada sin perder el resto ──
  {
    instalarFake({ fallosChunk: 2, codigosMalaSuerte: ['T0002'] })
    const archivo = [item(1), item(2), item(3)]
    const out = await mergeCatalogo(archivo)
    check('merge envenenada: cargados=2, errores=1', out.cargados === 2 && out.errores.length === 1)
    check('merge envenenada: error menciona el código T0002', /T0002/.test(out.errores[0]))
  }

  console.log(`\nTask 16 — catálogo masivo: ${ok} checks OK`)
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
