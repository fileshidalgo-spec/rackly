/**
 * RACKLY — Tests del motor de sincronización INCREMENTAL (lib/rackly/movs-sync.ts).
 * Ejecutar: bash scripts/run_all_tests.sh (suite PURA, sin stub de red)
 *
 * Contexto (rendimiento 2026-11-04): con 28K+ movimientos (~14.5 MB) la
 * re-descarga COMPLETA en cada cambio era el cuello de botella principal
 * (21 s medidos). El hook useMovimientosRealtime ahora aplica DELTAS
 * (realtime postgres_changes + fetch incremental por marca de agua) y reserva
 * la descarga completa como reparación. Esta suite garantiza la INVARIANTE
 * central: el dataset tras una cadena de deltas es IDÉNTICO al que daría una
 * descarga completa nueva (mismo conjunto, mismo orden global).
 *
 * Cubre: ordenarMovs (contrato f_modificacion DESC, id ASC), fusionarDeltas
 * (insert/update/orden/no-mutación), eliminarPorIds, marcaAgua, resumenDelta
 * y la equivalencia delta-cadena ≡ dataset-completo.
 */
const assert = require('assert')
const {
  ordenarMovs,
  fusionarDeltas,
  eliminarPorIds,
  marcaAgua,
  resumenDelta,
} = require('@/lib/rackly/movs-sync')

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

// Fábrica de filas mínimas (movs-sync solo usa id y fModificacion).
function mov(id, fModificacion, extra = {}) {
  return {
    id,
    fModificacion: fModificacion,
    tipo: 'INGRESO',
    bloque: '1',
    torre: '1',
    piso: '1',
    posicion: '1',
    codigo: 'COD-' + id,
    descripcion: 'desc ' + id,
    un: 'UND',
    cantidad: 10,
    fVencimiento: '',
    turno: 'DIA',
    usuarioId: 'u1',
    ...extra,
  }
}

const IDs = (movs) => movs.map((m) => m.id).join(',')

console.log('— ordenarMovs (contrato global f_modificacion DESC, id ASC) —')
t('ordena DESC por f_modificacion', () => {
  const orden = ordenarMovs([mov('a', '2026-11-04T10:00:00Z'), mov('b', '2026-11-04T12:00:00Z'), mov('c', '2026-11-04T08:00:00Z')])
  assert.strictEqual(IDs(orden), 'b,a,c')
})
t('desempate por id ASC con f_modificacion igual', () => {
  const orden = ordenarMovs([mov('c', 'T2'), mov('a', 'T2'), mov('b', 'T2')])
  assert.strictEqual(IDs(orden), 'a,b,c')
})
t('no muta la lista original (retorna ordenada nueva… muta in-place pero misma ref)', () => {
  // Contrato actual: ordenarMovs ordena in-place y retorna la misma lista
  // (la usa fusionarDeltas sobre una lista recién creada — siempre nueva).
  const lista = [mov('b', 'T2'), mov('a', 'T1')]
  const ret = ordenarMovs(lista)
  assert.strictEqual(ret, lista)
  assert.strictEqual(IDs(ret), 'b,a')
})

console.log('— fusionarDeltas —')
t('insert de fila nueva se agrega en su posición global', () => {
  const cache = [mov('a', 'T3'), mov('b', 'T1')]
  const out = fusionarDeltas(cache, [mov('n', 'T2')])
  assert.strictEqual(IDs(out), 'a,n,b')
})
t('update de fila existente REEMPLAZA por id (delta gana)', () => {
  const cache = [mov('a', 'T3', { cantidad: 10 }), mov('b', 'T1')]
  const out = fusionarDeltas(cache, [mov('a', 'T4', { cantidad: 99 })])
  assert.strictEqual(IDs(out), 'a,b')
  assert.strictEqual(out[0].cantidad, 99)
  assert.strictEqual(out.length, 2)
})
t('no muta el caché de entrada', () => {
  const cache = [mov('a', 'T3')]
  fusionarDeltas(cache, [mov('n', 'T4')])
  assert.strictEqual(cache.length, 1)
})
t('delta vacío retorna el mismo caché', () => {
  const cache = [mov('a', 'T3')]
  assert.strictEqual(fusionarDeltas(cache, []), cache)
})
t('ráfaga masiva (import Descarga) aplica todas y mantiene orden', () => {
  let cache = []
  const filas = []
  for (let i = 0; i < 300; i++) filas.push(mov('m' + i, 'T' + String(i).padStart(4, '0')))
  cache = fusionarDeltas(cache, filas)
  assert.strictEqual(cache.length, 300)
  // orden DESC por f_modificacion → m299 primero, m000 último
  assert.strictEqual(cache[0].id, 'm299')
  assert.strictEqual(cache[299].id, 'm0')
})

console.log('— eliminarPorIds —')
t('elimina por id y no muta la entrada', () => {
  const cache = [mov('a', 'T3'), mov('b', 'T1')]
  const out = eliminarPorIds(cache, ['b'])
  assert.strictEqual(IDs(out), 'a')
  assert.strictEqual(cache.length, 2)
})
t('ids inexistentes → no-op (misma ref)', () => {
  const cache = [mov('a', 'T3')]
  assert.strictEqual(eliminarPorIds(cache, ['zz']), cache)
})
t('lista de ids vacía → no-op', () => {
  const cache = [mov('a', 'T3')]
  assert.strictEqual(eliminarPorIds(cache, []), cache)
})

console.log('— marcaAgua —')
t('máximo f_modificacion del dataset', () => {
  assert.strictEqual(marcaAgua([mov('a', '2026-11-04T10:00:00Z'), mov('b', '2026-11-04T12:00:00Z')]), '2026-11-04T12:00:00Z')
})
t('null en dataset vacío', () => {
  assert.strictEqual(marcaAgua([]), null)
})
t('ignora filas con f_modificacion vacía', () => {
  assert.strictEqual(marcaAgua([mov('a', ''), mov('b', 'T1')]), 'T1')
})

console.log('— resumenDelta —')
t('cuenta nuevos vs actualizados', () => {
  const cache = [mov('a', 'T3')]
  const r = resumenDelta(cache, [mov('a', 'T4'), mov('n', 'T5')])
  assert.deepStrictEqual(r, { antes: 1, despues: 2, nuevos: 1 })
})

console.log('— INVARIANTE: cadena de deltas ≡ dataset completo —')
t('realtime (inserts + update + delete) + fetch incremental ≡ recarga completa', () => {
  // Dataset "BD" canónico (lo que devolvería fetchMovimientos completo)
  const bd = [
    mov('m1', 'T01'), mov('m2', 'T02'), mov('m3', 'T03'),
    mov('m4', 'T04'), mov('m5', 'T05'),
  ]
  // Cliente: descarga inicial (2 primeras filas de la oleada; el resto "aún no existía")
  let cache = [mov('m1', 'T01'), mov('m2', 'T02')]
  // 1) realtime INSERT m3 (payload.new con fila completa)
  cache = fusionarDeltas(cache, [mov('m3', 'T03')])
  // 2) realtime DELETE m2 (payload.old.id)
  cache = eliminarPorIds(cache, ['m2'])
  // 3) fetch incremental desde marca de agua: m4 (nuevo) y m1 (UPDATE con
  //    f_modificacion más nuevo — la fila delta gana)
  const deltas = [mov('m1', 'T06', { cantidad: 77 }), mov('m4', 'T04')]
  cache = fusionarDeltas(cache, deltas)
  // 4) realtime INSERT m5
  cache = fusionarDeltas(cache, [mov('m5', 'T05')])
  // BD canónica final: m2 borrado, m1 actualizado (T07 no — m1 quedó en T06)
  const esperado = [mov('m1', 'T06', { cantidad: 77 }), mov('m5', 'T05'), mov('m4', 'T04'), mov('m3', 'T03')]
  assert.strictEqual(IDs(cache), IDs(esperado))
  assert.deepStrictEqual(cache, esperado)
  // La marca de agua tras la cadena es la máxima f_modificacion
  assert.strictEqual(marcaAgua(cache), 'T06')
})

console.log('— resultado —')
console.log(`${ok} checks OK`)
if (process.exitCode) {
  console.error('FALLOS DETECTADOS')
  process.exit(1)
}
