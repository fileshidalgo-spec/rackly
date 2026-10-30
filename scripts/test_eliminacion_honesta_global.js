/**
 * RACKLY — Honestidad de los BORRADOS en TODOS los módulos (auditoría
 * 2026-10-31, Módulos: todos — patrón T173-00004281 generalizado).
 *
 * Ejecutar: bash scripts/run_all_tests.sh (suite CON_STUB)
 *
 * BUG REAL: la RLS de DELETE por rol FILTRA EN SILENCIO (HTTP 200, 0 filas,
 * sin error). Cualquier .delete() sin verificación de efecto es un éxito
 * falso. c66cf5f lo arregló en Recepción/Atención; esta auditoría lo
 * generaliza a RQ, RAL, Kardex (movimientos) y Piso + Catálogo:
 *   · eliminarRq / eliminarRal / deleteMovimiento: exigir ≥1 fila borrada.
 *   · eliminarMovimientosPorIds: contador HONESTO (filas realmente borradas).
 *   · piso: eliminarSector / eliminarMovimiento / eliminarMovimientoConPar.
 *   · clearCatalogo: si no borró NADA y queda catálogo → error controlado.
 *   · podarAnclasPisoSinUso: contador honesto.
 *   · rollbacks best-effort (registrarRq/registrarRal/rollbackCabeceras):
 *     NO lanzan — avisan en consola (el flujo converge por diseño).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const { eliminarRq } = require('@/lib/rackly/rq-atencion')
const { eliminarRal } = require('@/lib/rackly/ral')
const {
  deleteMovimiento,
  eliminarMovimientosPorIds,
} = require('@/lib/rackly/kardex')
const {
  eliminarSector,
  eliminarMovimiento,
  eliminarMovimientoConPar,
} = require('@/lib/piso/api')
const { clearCatalogo, podarAnclasPisoSinUso } = require('@/lib/rackly/catalogo')
const { codigoControladoDe, ERR_ELIMINAR_BLOQUEADO } = require('@/lib/rackly/errores')

let pasados = 0
let fallidos = 0
function check(nombre, cond, detalle = '') {
  if (cond) {
    pasados++
    console.log(`  ✓ ${nombre}`)
  } else {
    fallidos++
    console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`)
  }
}

async function capturaError(fn) {
  try {
    await fn()
    return null
  } catch (err) {
    return err
  }
}

const bloqueado = (err) => codigoControladoDe(err) === ERR_ELIMINAR_BLOQUEADO

async function main() {
  console.log('\n[1] eliminarRq — header filtrado por RLS ya NO es éxito falso')
  stub.__clear()
  const errRq = await capturaError(() => eliminarRq('rq1'))
  check('RQ no borrada → ELIMINAR_BLOQUEADO', bloqueado(errRq), JSON.stringify(errRq))
  stub.__setDeleteResult({ data: [{ id: 'rq1' }], error: null })
  stub.__setDeleteResult({ data: [{ id: 'i1' }, { id: 'i2' }], error: null })
  await eliminarRq('rq1')
  check('RQ borrada (header + 2 items) → resuelve sin error', true)

  console.log('\n[2] eliminarRal — misma honestidad (items caen por CASCADE)')
  stub.__clear()
  const errRal = await capturaError(() => eliminarRal('ral1'))
  check('RAL no borrado → ELIMINAR_BLOQUEADO', bloqueado(errRal), JSON.stringify(errRal))
  stub.__setDeleteResult({ data: [{ id: 'ral1' }], error: null })
  await eliminarRal('ral1')
  check('RAL borrado → resuelve sin error', true)

  console.log('\n[3] deleteMovimiento (Kardex) — éxito falso imposible')
  stub.__clear()
  stub.__setTable('movimientos', [{ id: 'm1', codigo: 'X1', cantidad: 5 }])
  const errMov = await capturaError(() => deleteMovimiento('m1'))
  check('movimiento no borrado → ELIMINAR_BLOQUEADO', bloqueado(errMov), JSON.stringify(errMov))
  stub.__setDeleteResult({ data: [{ id: 'm1' }], error: null })
  const restantes = await deleteMovimiento('m1')
  check('movimiento borrado → fetchMovimientos devuelve lo restante', Array.isArray(restantes) && restantes.length === 1)

  console.log('\n[4] eliminarMovimientosPorIds — contador HONESTO')
  stub.__clear()
  stub.__setDeleteResult({
    data: [{ id: 'a' }, { id: 'b' }], // RLS filtró la mitad del lote de 4
    error: null,
  })
  const res = await eliminarMovimientosPorIds(['a', 'b', 'c', 'd'])
  check(`eliminados refleja lo REAL (2, no 4): ${res.eliminados}`, res.eliminados === 2, JSON.stringify(res))
  check('sin errores HTTP (el filtro es silencioso — por eso el contador)', res.errores.length === 0)

  console.log('\n[5] piso.eliminarSector — honestidad')
  stub.__clear()
  stub.__setTable('piso_sectores', [{ id: 's1', nombre: 'Sector 1' }])
  const errSec = await capturaError(() => eliminarSector('s1'))
  check('sector no borrado → ELIMINAR_BLOQUEADO', bloqueado(errSec), JSON.stringify(errSec))
  stub.__setDeleteResult({ data: [{ id: 's1' }], error: null })
  const sectores = await eliminarSector('s1')
  check('sector borrado → listarSectores devuelve lo restante', Array.isArray(sectores) && sectores.length === 1)

  console.log('\n[6] piso.eliminarMovimiento — header filtrado detectado')
  stub.__clear()
  stub.__setTable('piso_movimientos', [{ id: 'pm1', tipo: 'ingreso' }])
  const errPm = await capturaError(() => eliminarMovimiento('pm1'))
  check('mov. de piso no borrado → ELIMINAR_BLOQUEADO', bloqueado(errPm), JSON.stringify(errPm))
  stub.__setDeleteResult({ data: [], error: null }) // detalles: sin filas (ok)
  stub.__setDeleteResult({ data: [{ id: 'pm1' }], error: null }) // header: 1 fila
  await eliminarMovimiento('pm1')
  check('detalles 0 + header 1 → resuelve sin error', true)

  console.log('\n[7] piso.eliminarMovimientoConPar — cuenta lo REALMENTE borrado')
  stub.__clear()
  stub.__setTable('piso_movimientos', [
    { id: 'pm1', uuid_sync: 'u1', tipo: 'salida' },
    { id: 'pm2', uuid_sync: 'u1', tipo: 'ingreso' },
  ])
  stub.__setDeleteResult({ data: [], error: null }) // detalles (sin filas enlatadas)
  stub.__setDeleteResult({ data: [{ id: 'pm1' }, { id: 'pm2' }], error: null }) // par completo
  const nPar = await eliminarMovimientoConPar('pm1')
  check(`traslado completo devuelve 2 cabeceras: ${nPar}`, nPar === 2)
  stub.__clear()
  stub.__setTable('piso_movimientos', [{ id: 'pm3', uuid_sync: null, tipo: 'salida' }])
  stub.__setDeleteResult({ data: [], error: null }) // detalles
  stub.__setDeleteResult({ data: [], error: null }) // header FILTRADO
  const errPar = await capturaError(() => eliminarMovimientoConPar('pm3'))
  check('header filtrado → ELIMINAR_BLOQUEADO (no «1 eliminada» falso)', bloqueado(errPar), JSON.stringify(errPar))

  console.log('\n[8] clearCatalogo — «catálogo vaciado» falso imposible')
  stub.__clear()
  stub.__setTable('catalogo', [{ codigo: 'A' }, { codigo: 'B' }])
  stub.__setTable('piso_movimiento_detalles', [])
  stub.__setTable('piso_bloques', [{ id: 'b1' }])
  stub.__setDeleteResult({ data: [], error: null }) // catalogo: RLS filtró TODO
  stub.__setDeleteResult({ data: [{ id: 'b1' }], error: null }) // poda interna
  const errCat = await capturaError(() => clearCatalogo())
  check('0 borradas + catálogo vivo → ELIMINAR_BLOQUEADO', bloqueado(errCat), JSON.stringify(errCat))
  stub.__clear()
  stub.__setTable('catalogo', [{ codigo: 'A' }, { codigo: 'B' }])
  stub.__setTable('piso_movimiento_detalles', [])
  stub.__setTable('piso_bloques', [{ id: 'b1' }])
  stub.__setDeleteResult({ data: [{ codigo: 'A' }, { codigo: 'B' }], error: null })
  stub.__setDeleteResult({ data: [{ id: 'b1' }], error: null })
  const restantesCat = await clearCatalogo()
  check('borrado real → devuelve lo restante sin error', Array.isArray(restantesCat) && restantesCat.length === 2)

  console.log('\n[9] podarAnclasPisoSinUso — contador honesto')
  stub.__clear()
  stub.__setTable('piso_movimiento_detalles', [])
  stub.__setTable('piso_bloques', [{ id: 'b1' }, { id: 'b2' }])
  stub.__setDeleteResult({ data: [{ id: 'b1' }], error: null }) // RLS filtró b2
  const podadas = await podarAnclasPisoSinUso()
  check(`podadas refleja lo real (1, no 2): ${podadas}`, podadas === 1)

  // ─── Resumen ───
  console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
  process.exit(fallidos > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
