/**
 * RACKLY — Tests de recepcion-idempotencia (M-1, auditoría 2026-10).
 * Ejecutar: npx esbuild scripts/test_recepcion_idempotencia.js --bundle
 *   --platform=node --outfile=/tmp/test_idem.cjs --alias:@=/ruta/src --loader:.ts=ts
 *   && node /tmp/test_idem.cjs
 */
const assert = require('assert')
const {
  nuevoUuid,
  extraerIndicePaleta,
  hayDuplicadosRecientes,
  VENTANA_DUPLICADO_SEG,
} = require('@/lib/rackly/recepcion-idempotencia')

let ok = 0
function t(nombre, fn) {
  try {
    fn()
    ok++
    console.log(`  ✓ ${nombre}`)
  } catch (e) {
    console.error(`  ✗ ${nombre}: ${e.message}`)
    process.exitCode = 1
  }
}

console.log('— recepcion-idempotencia —')

t('VENTANA_DUPLICADO_SEG = 60', () => {
  assert.strictEqual(VENTANA_DUPLICADO_SEG, 60)
})

t('nuevoUuid: formato v4 y unicidad (1000)', () => {
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const vistos = new Set()
  for (let i = 0; i < 1000; i++) {
    const u = nuevoUuid()
    assert.ok(v4.test(u), `formato inválido: ${u}`)
    vistos.add(u)
  }
  assert.strictEqual(vistos.size, 1000, 'hay colisiones')
})

t('extraerIndicePaleta: extrae i de "Paleta i/N"', () => {
  assert.strictEqual(extraerIndicePaleta('Obs usuario · Paleta 3/7'), 3)
  assert.strictEqual(extraerIndicePaleta('Paleta 1/2'), 1)
  assert.strictEqual(extraerIndicePaleta('Paleta 12/40'), 12)
})

t('extraerIndicePaleta: null sin marca o texto ajeno', () => {
  assert.strictEqual(extraerIndicePaleta(null), null)
  assert.strictEqual(extraerIndicePaleta(''), null)
  assert.strictEqual(extraerIndicePaleta('obs del usuario sin paleta'), null)
  assert.strictEqual(extraerIndicePaleta('la Paleta X/Y no es marca'), null)
})

t('extraerIndicePaleta: tolera espacios y ·', () => {
  assert.strictEqual(extraerIndicePaleta('x · Paleta 2/5'), 2)
})

t('extraerIndicePaleta: doble espacio NO es marca (igual que recepcion-filas)', () => {
  assert.strictEqual(extraerIndicePaleta('Paleta  2/5'), null)
})

;(async () => {
  // hayDuplicadosRecientes: caminos SIN BD (retornos tempranos)
  t('hayDuplicadosRecientes: [] → false sin tocar BD', async () => {
    assert.strictEqual(await hayDuplicadosRecientes([]), false)
  })
  t('hayDuplicadosRecientes: sin número de documento → false', async () => {
    assert.strictEqual(
      await hayDuplicadosRecientes([
        { numeroDocumento: '  ', codigo: 'X', cantidad: 1 },
      ]),
      false
    )
  })
  console.log(`\n${ok + 2} tests OK${process.exitCode ? ' (con fallos)' : ''}`)
})()
