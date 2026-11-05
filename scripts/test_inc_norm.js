/**
 * RACKLY — Tests de normalización de códigos INC (lib/rackly/inc-norm.ts).
 * Ejecutar: bash scripts/run_all_tests.sh (suite CON_STUB no requerida: módulo puro)
 *
 * Contexto (trace 1a1abde848bba415, 2026-11-05): la BD tenía el MISMO INC físico
 * registrado bajo variantes — «Inc26-577»/«INC26-577» y «INC026-451»/«INC26-451» —
 * y el agrupamiento por cadena EXACTA lo mostraba como DOS INC con stock dividido
 * (split-brain). La reparación normalizó 29 filas en BD y, hacia adelante,
 * normalizarCodigoInc se aplica en TODA escritura (kardex insert/RPC ×4, traslado
 * ×2, bulk, piso ×2) y en TODA agrupación por lectura (fetchIncPorUbicacion,
 * StockIncTab).
 */
const assert = require('assert')
const { normalizarCodigoInc } = require('@/lib/rackly/inc-norm')

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

console.log('normalizarCodigoInc — vacíos')
t('null → null', () => {
  assert.strictEqual(normalizarCodigoInc(null), null)
})
t('undefined → null', () => {
  assert.strictEqual(normalizarCodigoInc(undefined), null)
})
t('cadena vacía → null', () => {
  assert.strictEqual(normalizarCodigoInc(''), null)
})
t('solo espacios → null', () => {
  assert.strictEqual(normalizarCodigoInc('   '), null)
})

console.log('normalizarCodigoInc — canónicos intactos')
t('INC26-577 queda igual', () => {
  assert.strictEqual(normalizarCodigoInc('INC26-577'), 'INC26-577')
})
t('INC12-34 (año sin cero extra) queda igual', () => {
  assert.strictEqual(normalizarCodigoInc('INC12-34'), 'INC12-34')
})
t('INC26-110/003 (prefijo cero del consecutivo NO se toca)', () => {
  assert.strictEqual(normalizarCodigoInc('INC26-110/003'), 'INC26-110/003')
})

console.log('normalizarCodigoInc — variantes de case detectadas en producción')
t('Inc26-577 → INC26-577', () => {
  assert.strictEqual(normalizarCodigoInc('Inc26-577'), 'INC26-577')
})
t('inc26-578 (todo minúsculas) → INC26-578', () => {
  assert.strictEqual(normalizarCodigoInc('inc26-578'), 'INC26-578')
})
t('espacios alrededor → trim + mayúsculas', () => {
  assert.strictEqual(normalizarCodigoInc('  Inc26-445 '), 'INC26-445')
})

console.log('normalizarCodigoInc — cero extra del año (INC026 → INC26)')
t('INC026-429 → INC26-429', () => {
  assert.strictEqual(normalizarCodigoInc('INC026-429'), 'INC26-429')
})
t('Inc026-451 → INC26-451', () => {
  assert.strictEqual(normalizarCodigoInc('Inc026-451'), 'INC26-451')
})
t('inc026-501 → INC26-501', () => {
  assert.strictEqual(normalizarCodigoInc('inc026-501'), 'INC26-501')
})

console.log('normalizarCodigoInc — texto libre: SOLO trim + mayúsculas (sin inventar)')
t('Elmer-01 → ELMER-01', () => {
  assert.strictEqual(normalizarCodigoInc('Elmer-01'), 'ELMER-01')
})
t('LIBERADO??? queda LIBERADO???', () => {
  assert.strictEqual(normalizarCodigoInc('LIBERADO???'), 'LIBERADO???')
})
t('Dañadas → DAÑADAS (unicode intacto)', () => {
  assert.strictEqual(normalizarCodigoInc('Dañadas'), 'DAÑADAS')
})
t('INC435 (sin año) queda tal cual', () => {
  assert.strictEqual(normalizarCodigoInc('INC435'), 'INC435')
})

console.log('normalizarCodigoInc — invariantes del convenio')
t('aplicar dos veces es idempotente', () => {
  const casos = ['Inc26-579', 'INC026-110', 'ELMER-01', 'INC26-577']
  for (const c of casos) {
    assert.strictEqual(normalizarCodigoInc(normalizarCodigoInc(c)), normalizarCodigoInc(c))
  }
})
t('variantes distintas del MISMO INC convergen a la misma clave', () => {
  const canon = normalizarCodigoInc('INC26-577')
  for (const v of ['Inc26-577', 'inc26-577', 'INC26-577', ' INC26-577 ']) {
    assert.strictEqual(normalizarCodigoInc(v), canon)
  }
})
t('INC026-x e INC26-x convergen (merge de split-brain)', () => {
  assert.strictEqual(normalizarCodigoInc('INC026-451'), normalizarCodigoInc('INC26-451'))
})

console.log(`\n${ok} checks OK`)
console.log(`INC-NORM: ${ok} pasaron, ${process.exitCode ? 1 : 0} fallaron`)
