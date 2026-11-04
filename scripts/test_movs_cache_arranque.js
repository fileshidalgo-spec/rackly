/**
 * RACKLY — Tests del caché persistente + arranque caliente (rendimiento 2026-11-05).
 * Ejecutar: bash scripts/run_all_tests.sh (suite PURA, sin red ni IndexedDB)
 *
 * Contexto: el caché del singleton useMovimientosRealtime era solo memoria —
 * cada F5/recarga re-descargaba la tabla completa (28K filas ≈ 14.5 MB ≈ 21 s).
 * Ahora movs-cache.ts persiste el dataset en IndexedDB y el hook lo siembra
 * («arranque caliente») mostrando datos al instante, validando contra BD por
 * delta. Esta suite garantiza:
 *
 *  1. validarCacheGuardado: payload válido aceptado; versiones/vacíos/malos
 *     formas descartados (nunca se siembran datos incompatibles).
 *  2. INVARIANTE central del arranque: sembrar desde el caché persistido +
 *     cadena de deltas ≡ dataset completo descargado de cero (mismo conjunto
 *     y mismo orden global f_modificacion DESC, id ASC).
 *  3. Bajas conocidas (deleteMovimiento): sembrar + eliminarPorIds ≡ dataset
 *     reconstruido sin esas filas.
 *  4. Marca de agua: la del dataset sembrado coincide con la del reconstruido
 *     (el corte del delta post-arranque es exacto).
 */
const assert = require('assert')
const {
  validarCacheGuardado,
  CACHE_MOVS_SCHEMA,
} = require('@/lib/rackly/movs-cache')
const {
  ordenarMovs,
  fusionarDeltas,
  eliminarPorIds,
  marcaAgua,
} = require('@/lib/rackly/movs-sync')

let ok = 0
function t(nombre, fn) {
  try {
    fn()
    ok++
    console.log(`  ✓ ${nombre}`)
  } catch (e) {
    console.error(`  ✗ ${nombre}\n    ${e.message}`)
    process.exitCode = 1
  }
}

// ── Factorías ────────────────────────────────────────────────
function mov(id, fmod, cant) {
  return {
    id,
    tipo: 'ingreso',
    bloque: '5',
    torre: '1',
    piso: '3',
    posicion: String((parseInt(id.replace(/\D/g, ''), 10) % 20) + 1),
    codigo: 'C-' + (parseInt(id.replace(/\D/g, ''), 10) % 10),
    descripcion: 'Artículo ' + id,
    un: 'UND',
    cantidad: cant ?? 10,
    fVencimiento: '',
    fModificacion: fmod,
    turno: 'Día',
    usuarioId: 'u1',
  }
}
const fecha = (n) => `2026-11-05T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`

// ── 1. validarCacheGuardado ──────────────────────────────────
console.log('validarCacheGuardado:')
t('acepta un payload válido y conserva los campos', () => {
  const movs = [mov('a1', fecha(1)), mov('a2', fecha(2))]
  const payload = { schema: CACHE_MOVS_SCHEMA, movs, marcaAgua: fecha(2), guardadoEn: 1730000000000 }
  const r = validarCacheGuardado(payload)
  assert.ok(r)
  assert.strictEqual(r.schema, CACHE_MOVS_SCHEMA)
  assert.strictEqual(r.movs.length, 2)
  assert.strictEqual(r.marcaAgua, fecha(2))
  assert.strictEqual(r.guardadoEn, 1730000000000)
})
t('descarta basura (null, números, strings)', () => {
  assert.strictEqual(validarCacheGuardado(null), null)
  assert.strictEqual(validarCacheGuardado(42), null)
  assert.strictEqual(validarCacheGuardado('movs'), null)
  assert.strictEqual(validarCacheGuardado(undefined), null)
})
t('descarta schema distinto (formato incompatible → no siembra datos viejos)', () => {
  const p = { schema: CACHE_MOVS_SCHEMA + 1, movs: [mov('a1', fecha(1))], marcaAgua: null, guardadoEn: 1 }
  assert.strictEqual(validarCacheGuardado(p), null)
})
t('descarta movs vacío o no-array', () => {
  assert.strictEqual(validarCacheGuardado({ schema: 1, movs: [], marcaAgua: null, guardadoEn: 1 }), null)
  assert.strictEqual(validarCacheGuardado({ schema: 1, movs: 'no', marcaAgua: null, guardadoEn: 1 }), null)
})
t('descarta guardadoEn malformado y marcaAgua no-string', () => {
  assert.strictEqual(validarCacheGuardado({ schema: 1, movs: [mov('a1', fecha(1))], marcaAgua: null, guardadoEn: 'ayer' }), null)
  assert.strictEqual(validarCacheGuardado({ schema: 1, movs: [mov('a1', fecha(1))], marcaAgua: 99, guardadoEn: 1 }), null)
})
t('descarta payload cuya primera fila no tiene id (inservible para deltas)', () => {
  const sinId = { ...mov('a1', fecha(1)) }
  delete sinId.id
  assert.strictEqual(validarCacheGuardado({ schema: 1, movs: [sinId], marcaAgua: null, guardadoEn: 1 }), null)
})

// ── 2. INVARIANTE del arranque caliente ──────────────────────
console.log('invariante: sembrar del caché + deltas ≡ descarga completa:')
t('cadena arranque + deltas produce EXACTAMENTE el dataset completo', () => {
  // Sesión anterior: 100 filas guardadas en IndexedDB
  const semilla = ordenarMovs(Array.from({ length: 100 }, (_, i) => mov('m' + i, fecha(i))))
  const guardado = { schema: CACHE_MOVS_SCHEMA, movs: semilla, marcaAgua: marcaAgua(semilla), guardadoEn: Date.now() }

  // Arranque: validar + sembrar (el hook hace exactamente este camino)
  const leido = validarCacheGuardado(guardado)
  assert.ok(leido)
  let dataset = leido.movs

  // Mientras la app estuvo cerrada: 30 altas, 10 updates (por otras sesiones)
  const deltas = []
  for (let i = 100; i < 130; i++) deltas.push(mov('m' + i, fecha(1000 + i)))
  for (let i = 0; i < 10; i++) deltas.push(mov('m' + i, fecha(2000 + i), 999)) // updates
  dataset = fusionarDeltas(dataset, deltas)

  // Referencia: descarga completa de cero (lo que habría bajado la app)
  const completa = ordenarMovs([
    ...Array.from({ length: 100 }, (_, i) => (i < 10 ? mov('m' + i, fecha(2000 + i), 999) : mov('m' + i, fecha(i)))),
    ...Array.from({ length: 30 }, (_, i) => mov('m' + (100 + i), fecha(1000 + 100 + i))),
  ])

  assert.strictEqual(dataset.length, completa.length)
  assert.deepStrictEqual(dataset, completa)
})
t('bajas conocidas (deleteMovimiento) sobre el sembrado ≡ reconstruido sin ellas', () => {
  const semilla = ordenarMovs(Array.from({ length: 50 }, (_, i) => mov('m' + i, fecha(i))))
  const leido = validarCacheGuardado({ schema: 1, movs: semilla, marcaAgua: marcaAgua(semilla), guardadoEn: 1 })
  const conBajas = eliminarPorIds(leido.movs, ['m5', 'm17', 'm40'])
  const referencia = semilla.filter((m) => !['m5', 'm17', 'm40'].includes(m.id))
  assert.strictEqual(conBajas.length, referencia.length)
  assert.deepStrictEqual(conBajas, ordenarMovs(referencia))
})
t('delta vacío tras arranque NO muta el dataset (referencia estable)', () => {
  const semilla = ordenarMovs(Array.from({ length: 20 }, (_, i) => mov('m' + i, fecha(i))))
  const leido = validarCacheGuardado({ schema: 1, movs: semilla, marcaAgua: marcaAgua(semilla), guardadoEn: 1 })
  const trasDelta = fusionarDeltas(leido.movs, [])
  assert.strictEqual(trasDelta, leido.movs) // misma referencia: sin re-render innecesario
})
t('marca de agua del sembrado = marca de agua del dataset reconstruido', () => {
  const semilla = ordenarMovs(Array.from({ length: 40 }, (_, i) => mov('m' + i, fecha(i))))
  const leido = validarCacheGuardado({ schema: 1, movs: semilla, marcaAgua: marcaAgua(semilla), guardadoEn: 1 })
  const deltas = [mov('m100', fecha(5000))]
  const sembrado = fusionarDeltas(leido.movs, deltas)
  const completo = ordenarMovs([...semilla, deltas[0]])
  assert.strictEqual(marcaAgua(sembrado), marcaAgua(completo))
  assert.strictEqual(marcaAgua(sembrado), fecha(5000))
})

console.log(`\nSuites de caché/arranque: ${ok} OK${process.exitCode ? ' · CON FALLOS' : ''}`)
