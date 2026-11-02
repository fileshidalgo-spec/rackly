/**
 * RACKLY — Tests del mapa INC compartido (lib/rackly/mapa-inc.ts).
 * Ejecutar: bash scripts/run_all_tests.sh (suite CON_STUB)
 *
 * Contexto (trace 1a19c8089fb5fba5, 2026-11-02): usuarios veían celdas INC en
 * VERDE («Vacío») en vez de rosado cuando la consulta INC fallaba — el merge
 * llegaba vacío (_error) y el fallback RPC v1 ni siquiera fusionaba INC.
 * Cubre: fusionarIncEnCeldas (mixta / solo-INC / clave canónica) y
 * fetchIncPorUbicacionConReintento (éxito 1er intento, recuperación en el 2º,
 * fallo persistente, _truncated no se reintenta).
 */
const assert = require('assert')
const { fusionarIncEnCeldas, fetchIncPorUbicacionConReintento, claveCelda } = require('@/lib/rackly/mapa-inc')

let ok = 0
function t(nombre, fn) {
  try {
    fn()
    ok++
    console.log('  ✓', nombre)
  } catch (e) {
    console.error('  ✗', nombre, '\n    ', e.message)
    process.exitCode = 1
  }
}

function mapaIncDe(entries, flags = {}) {
  const m = new Map(entries)
  if (flags._error) m._error = true
  if (flags._truncated) m._truncated = true
  return m
}

console.log('claveCelda — formato canónico')
t('bloque-torre-piso-posición sin normalizar espacios', () => {
  assert.strictEqual(claveCelda({ bloque: '1', torre: '2', piso: '3', posicion: '5' }), '1-2-3-5')
})

console.log('fusionarIncEnCeldas — merge INC sobre celdas de ocupación')
t('celda existente gana tieneInc + incItems (mixta)', () => {
  const celdas = [{ bloque: '1', torre: '1', piso: '1', posicion: '1', stock: 12, codigos: ['ART-1'], lotes: 1, tieneInc: false, incItems: [] }]
  const inc = mapaIncDe([['1-1-1-1', [{ codigo: 'ART-9', descripcion: 'Insumo X', codigoInc: 'INC001', cantidad: 3 }]]])
  const out = fusionarIncEnCeldas(celdas, inc)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].tieneInc, true)
  assert.strictEqual(out[0].stock, 12) // el stock normal NO cambia
  assert.strictEqual(out[0].incItems.length, 1)
  assert.strictEqual(out[0].incItems[0].codigoInc, 'INC001')
})

t('celda SOLO INC se añade con stock 0 (físicamente bloqueada, nunca «Vacío»)', () => {
  const celdas = [{ bloque: '1', torre: '1', piso: '1', posicion: '1', stock: 5, codigos: ['ART-1'], lotes: 1, tieneInc: false, incItems: [] }]
  const inc = mapaIncDe([['2-1-1-4', [{ codigo: 'ART-7', descripcion: 'Insumo Y', codigoInc: 'INC026-120', cantidad: 8 }]]])
  const out = fusionarIncEnCeldas(celdas, inc)
  assert.strictEqual(out.length, 2)
  const solo = out.find(c => c.bloque === '2')
  assert.ok(solo, 'la celda solo-INC debe existir')
  assert.strictEqual(solo.stock, 0)
  assert.strictEqual(solo.tieneInc, true)
  assert.deepStrictEqual(solo.codigos, ['ART-7'])
  assert.strictEqual(solo.lotes, 1)
})

t('mapa INC vacío (sin INC en BD) no altera las celdas', () => {
  const celdas = [{ bloque: '1', torre: '1', piso: '1', posicion: '1', stock: 5, codigos: ['ART-1'], lotes: 1, tieneInc: false, incItems: [] }]
  const out = fusionarIncEnCeldas(celdas, new Map())
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].tieneInc, false)
})

t('varios INC en la misma celda se mantienen como lista', () => {
  const inc = mapaIncDe([['3-2-4-2', [
    { codigo: 'ART-A', descripcion: '', codigoInc: 'INC001', cantidad: 1 },
    { codigo: 'ART-B', descripcion: '', codigoInc: 'INC002', cantidad: 2 },
  ]]])
  const out = fusionarIncEnCeldas([], inc)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].incItems.length, 2)
  assert.strictEqual(out[0].codigos.length, 2)
})

console.log('fetchIncPorUbicacionConReintento — resiliencia ante _error')
t('éxito al 1er intento: 1 sola consulta, sin reintentos', async () => {
  let llamadas = 0
  const base = async () => { llamadas++; return mapaIncDe([['1-1-1-1', [{ codigo: 'A', descripcion: '', codigoInc: 'INC1', cantidad: 1 }]]]) }
  const r = await fetchIncPorUbicacionConReintento(base, { intentos: 3, pausaMs: 1 })
  assert.strictEqual(llamadas, 1)
  assert.strictEqual(r.size, 1)
  assert.strictEqual(r._error, undefined)
})

t('fallo transitorio: _error al 1º, éxito al 2º → devuelve datos buenos', async () => {
  let llamadas = 0
  const base = async () => {
    llamadas++
    return llamadas === 1 ? mapaIncDe([], { _error: true }) : mapaIncDe([['2-1-1-1', [{ codigo: 'B', descripcion: '', codigoInc: 'INC2', cantidad: 2 }]]])
  }
  const r = await fetchIncPorUbicacionConReintento(base, { intentos: 2, pausaMs: 1 })
  assert.strictEqual(llamadas, 2)
  assert.strictEqual(r._error, undefined)
  assert.strictEqual(r.size, 1)
})

t('fallo persistente: respeta intentos y devuelve _error (la UI muestra el banner)', async () => {
  let llamadas = 0
  const base = async () => { llamadas++; return mapaIncDe([], { _error: true }) }
  const r = await fetchIncPorUbicacionConReintento(base, { intentos: 3, pausaMs: 1 })
  assert.strictEqual(llamadas, 3)
  assert.strictEqual(r._error, true)
  assert.strictEqual(r.size, 0)
})

t('_truncated NO se reintenta (datos parciales pero válidos)', async () => {
  let llamadas = 0
  const base = async () => { llamadas++; return mapaIncDe([['1-1-1-1', [{ codigo: 'C', descripcion: '', codigoInc: 'INC3', cantidad: 5 }]]], { _truncated: true }) }
  const r = await fetchIncPorUbicacionConReintento(base, { intentos: 2, pausaMs: 1 })
  assert.strictEqual(llamadas, 1)
  assert.strictEqual(r._truncated, true)
})

console.log(`\n${ok} checks OK`)
if (process.exitCode) console.error('HUBO FALLOS')
