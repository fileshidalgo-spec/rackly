/**
 * RACKLY — Tests Navegación Stock → Posición + Retorno (Módulos PISO y RACKS).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_piso_navegacion.js --bundle --platform=node \
 *     --alias:@=/home/z/my-project/rackly/src \
 *     --alias:@/lib/supabase/client=/home/z/my-project/rackly/scripts/stubs/supabase_client_stub.js \
 *     --external:xlsx,react,@supabase/ssr \
 *     --outfile=scripts/.testbuild/test_piso_navegacion.cjs --loader:.ts=ts --loader:.tsx=tsx \
 *     && node scripts/.testbuild/test_piso_navegacion.cjs
 *
 * Regresión (denuncia del usuario, Módulo Piso y Racks):
 *   - "al salir las ubicaciones poder darle clic que redirija a la posición donde
 *     puedas realizar los movimientos correspondientes" → StockPisoItem ahora
 *     transporta sector_id/posicion_id/... y targetDesdeStockItem + resolverPosicionTarget
 *     resuelven el deep-link hacia Sectores (Piso) — Ocupación ya lo tenía (Racks).
 *   - "botón de retorno a la pestaña de Stock para seguir buscando otros artículos"
 *     → saveTabState/loadTabState persisten la búsqueda en sessionStorage para que
 *     el retorno no se limpie.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const supabaseStub = require('@/lib/supabase/client')
const {
  targetDesdeStockItem,
  resolverPosicionTarget,
  firmaTarget,
} = require('@/lib/piso/navegacion.ts')
const { stockPisoBuscar, stockPisoGlobal } = require('@/lib/piso/api.ts')
const { saveTabState, loadTabState } = require('@/lib/rackly/tab-state.ts')

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// Posición de un sector Piso (formato PosicionConStock, como devuelve cargarPosicionesSector)
function pos(id, letra, numero, subcol, stock = 10) {
  return { posicionId: id, posicionNumero: numero, subcolumnaCodigo: subcol, columnaLetra: letra, stock, bloques: [] }
}

function main() {
  // ═══ 1. targetDesdeStockItem — extrae el target de navegación ═══
  console.log('\n1) targetDesdeStockItem — fila con ubicación resuelta')
  const itemCompleto = {
    bloque_codigo: '36925', bloque_descripcion: 'X', bloque_unidad: 'KG',
    ubicacion: 'A-A1-Pos 3', sector_nombre: 'Sector 1', cantidad: 100,
    fecha_vencimiento: '2026-11-17',
    sector_id: 'SEC1', posicion_id: 'P1', posicion_numero: 3,
    columna_letra: 'A', subcolumna_codigo: 'A1',
  }
  const t = targetDesdeStockItem(itemCompleto)
  check('target no nulo', !!t)
  check('sector_id transportado', t?.sector_id === 'SEC1')
  check('posicion_id transportado', t?.posicion_id === 'P1')
  check('columna/numero/subcolumna transportados', t?.columna_letra === 'A' && t?.posicion_numero === 3 && t?.subcolumna_codigo === 'A1')
  check('ubicación legible para el banner', t?.ubicacion === 'A-A1-Pos 3')
  check('código del artículo para contexto', t?.bloque_codigo === '36925')

  console.log('\n2) targetDesdeStockItem — fila SIN ubicación resuelta')
  const sinLoc = { ...itemCompleto, sector_id: undefined, posicion_id: undefined }
  check('sin ids → null (no botón roto)', targetDesdeStockItem(sinLoc) === null)
  const soloSector = { ...itemCompleto, posicion_id: undefined }
  check('sector sin posición → null', targetDesdeStockItem(soloSector) === null)

  // ═══ 3. resolverPosicionTarget — resolución en Sectores ═══
  console.log('\n3) resolverPosicionTarget — por ID canónico')
  const posiciones = [pos('P1', 'A', 3, 'A1'), pos('P2', 'A', 4, 'A1'), pos('P3', 'B', 1, 'B1')]
  const res = resolverPosicionTarget(posiciones, { sector_id: 'SEC1', posicion_id: 'P1' })
  check('resuelve por posicionId', res?.posicionId === 'P1')
  check('la posición resuelta tiene coordenadas para el detalle', res?.columnaLetra === 'A' && res?.posicionNumero === 3)

  console.log('\n4) resolverPosicionTarget — fallback por coordenadas (ID obsoleto)')
  const res2 = resolverPosicionTarget(posiciones, { sector_id: 'SEC1', posicion_id: 'GONE', columna_letra: 'A', posicion_numero: 4, subcolumna_codigo: 'A1' })
  check('ID inexistente → resuelve por columna+número+subcolumna', res2?.posicionId === 'P2')
  const res3 = resolverPosicionTarget(posiciones, { sector_id: 'SEC1', posicion_id: 'GONE', columna_letra: 'A', posicion_numero: 4, subcolumna_codigo: 'OTRA' })
  check('subcolumna distinta → NO resuelve (evita posición equivocada)', res3 === null)
  const res4 = resolverPosicionTarget(posiciones, { sector_id: 'SEC1', posicion_id: 'GONE' })
  check('sin coordenadas y sin ID → null', res4 === null)
  const res5 = resolverPosicionTarget(posiciones, { sector_id: 'SEC1', posicion_id: 'GONE', columna_letra: 'Z', posicion_numero: 99 })
  check('coordenadas inexistentes → null', res5 === null)

  // ═══ 5. firmaTarget — aplica el deep-link una sola vez por destino ═══
  console.log('\n5) firmaTarget')
  check('firma estable sector|posición', firmaTarget(t) === 'SEC1|P1')
  check('null → firma vacía', firmaTarget(null) === '')
  check('incompleto → firma vacía', firmaTarget({ sector_id: 'S', posicion_id: '' }) === '')

  // ═══ 6. saveTabState / loadTabState — persistencia de búsqueda ═══
  console.log('\n6) saveTabState/loadTabState — roundtrip sessionStorage')
  const store = new Map()
  globalThis.window = {
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  }
  saveTabState('piso.stock', { q: 'ACIDO', filter: 'todos' })
  const restored = loadTabState('piso.stock', { q: '', filter: 'todos' })
  check('roundtrip del término de búsqueda', restored.q === 'ACIDO')
  check('roundtrip del filtro', restored.filter === 'todos')
  check('clave prefijada (namespace rackly)', store.has('rackly.tab.piso.stock'))

  console.log('\n7) loadTabState — defensa ante datos corruptos / ausentes')
  store.set('rackly.tab.roto', '{no-json')
  const roto = loadTabState('roto', { q: 'fallback' })
  check('JSON corrupto → fallback', roto.q === 'fallback')
  const ausente = loadTabState('nunca-guardado', { x: 7 })
  check('clave ausente → fallback', ausente.x === 7)
  store.set('rackly.tab.nulo', 'null')
  check('null guardado → fallback', loadTabState('nulo', { x: 1 }).x === 1)

  console.log('\n8) sin window (prerender/SSR) — no debe lanzar')
  const winPrevio = globalThis.window
  delete globalThis.window
  let sinError = true
  try {
    saveTabState('x', { a: 1 })
    const v = loadTabState('x', { a: 2 })
    sinError = v.a === 2
  } catch { sinError = false }
  check('save/load sin window → fallback sin lanzar', sinError)
  globalThis.window = winPrevio
}

async function mainAsync() {
  // ═══ 9. stockPisoBuscar — propaga los IDs de navegación (deep-link) ═══
  console.log('\n9) stockPisoBuscar — items con sector_id/posicion_id/coordenadas')
  const LOC = {
    posicion_id: 'P1',
    piso_posiciones: {
      numero: 3, subcolumna_id: 'S1',
      piso_subcolumnas: { codigo: 'BA1', columna_id: 'C1',
        piso_columnas: { letra: 'A', sector_id: 'SEC1',
          piso_sectores: { nombre: 'Sector 1', n_columnas: 2, n_subcolumnas: 2 } } },
    },
  }
  supabaseStub.__setTable('piso_bloques', [
    { id: 'B1', codigo: '48035', descripcion: 'LAMINA TERMOCONTRAIBLE', unidad: 'KG' },
  ])
  supabaseStub.__setTable('piso_movimiento_detalles', [
    { bloque_id: 'B1', nivel_id: 'N1', cantidad: 100, fecha_vencimiento: '2026-11-17',
      piso_movimientos: { tipo: 'ingreso', codigo_inc: null, fecha: '2026-06-01T10:00:00+00:00' }, piso_niveles: LOC },
    { bloque_id: 'B1', nivel_id: 'N1', cantidad: 300, fecha_vencimiento: '2027-01-31',
      piso_movimientos: { tipo: 'ingreso', codigo_inc: 'INC-7', fecha: '2026-09-20T10:00:00+00:00' }, piso_niveles: LOC },
  ])
  const items = await stockPisoBuscar('48035')
  check('2 lotes reales', items.length === 2, JSON.stringify(items))
  check('sector_id propagado (deep-link posible)', items[0]?.sector_id === 'SEC1')
  check('posicion_id propagado', items[0]?.posicion_id === 'P1')
  check('posicion_numero/columna/subcolumna propagados', items[0]?.posicion_numero === 3 && items[0]?.columna_letra === 'A' && items[0]?.subcolumna_codigo === 'BA1')
  const target = targetDesdeStockItem(items[0])
  check('targetDesdeStockItem resuelve el item REAL de la consulta', target?.posicion_id === 'P1' && target?.sector_id === 'SEC1')

  // ═══ 10. stockPisoGlobal — misma propagación vía locMap (FEFO/INC) ═══
  console.log('\n10) stockPisoGlobal — items FEFO/INC con IDs de navegación')
  supabaseStub.__setTable('piso_movimiento_detalles', [
    { bloque_id: 'B1', nivel_id: 'N1', cantidad: 100, fecha_vencimiento: '2026-11-17', movimiento_id: 'M1',
      piso_movimientos: { tipo: 'ingreso', codigo_inc: null, fecha: '2026-06-01T10:00:00+00:00' } },
  ])
  supabaseStub.__setTable('piso_bloques', [{ id: 'B1', codigo: '48035', descripcion: 'LAMINA', unidad: 'KG' }])
  supabaseStub.__setTable('piso_niveles', [{ id: 'N1', posicion_id: 'P1' }])
  supabaseStub.__setTable('piso_posiciones', [{ id: 'P1', numero: 3, subcolumna_id: 'S1' }])
  supabaseStub.__setTable('piso_subcolumnas', [{ id: 'S1', codigo: 'BA1', columna_id: 'C1' }])
  supabaseStub.__setTable('piso_columnas', [{ id: 'C1', letra: 'A', sector_id: 'SEC1' }])
  supabaseStub.__setTable('piso_sectores', [{ id: 'SEC1', nombre: 'Sector 1', n_columnas: 2, n_subcolumnas: 2 }])
  const gitems = await stockPisoGlobal()
  check('1 lote global', gitems.length === 1, JSON.stringify(gitems))
  check('sector_id propagado en stockPisoGlobal', gitems[0]?.sector_id === 'SEC1')
  check('posicion_id propagado en stockPisoGlobal', gitems[0]?.posicion_id === 'P1')
  check('coordenadas propagadas en stockPisoGlobal', gitems[0]?.posicion_numero === 3 && gitems[0]?.columna_letra === 'A' && gitems[0]?.subcolumna_codigo === 'BA1')
  const gtarget = targetDesdeStockItem(gitems[0])
  check('deep-link resolvible también desde FEFO/INC', gtarget?.posicion_id === 'P1')
}

main()
mainAsync()
  .then(() => {
    console.log(`\n═══ RESULTADO: ${passed} OK, ${failed} FALLOS ═══`)
    process.exit(failed > 0 ? 1 : 0)
  })
  .catch((err) => {
    console.error('ERROR FATAL EN TESTS:', err)
    process.exit(1)
  })
