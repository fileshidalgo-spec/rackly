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
 *   · piso: eliminarSector + clearCatalogo + podarAnclasPisoSinUso (client-side).
 *     eliminarMovimiento/ConPar: desde el refactor 20261107 son la RPC atómica
 *     piso_eliminar_movimiento — la honestidad vive server-side (RAISE si 0
 *     filas) y el cliente debe PROPAGAR ese error (secciones [6] y [7]).
 *   · clearCatalogo: si no borró NADA y queda catálogo → error controlado.
 *   · podarAnclasPisoSinUso: contador honesto.
 *   · rollbacks best-effort (registrarRq/registrarRal/rollbackCabeceras):
 *     NO lanzan — avisan en consola (el flujo converge por diseño).
 *
 * Aditivo 2026-11-01 (auditoría integral — clase espejo): la RLS de UPDATE
 * también filtra en silencio. Se verifica exigirActualizadas en:
 *   · cambiarEstadoGuia / cambiarEstadoAtencion (modulos.ts).
 *   · recalcularEstadoRq (vía atenderItemRq) / recalcularEstadoRal (vía
 *     atenderItemRal) — el encabezado ya no queda con estado viejo.
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
const {
  codigoControladoDe,
  ERR_ELIMINAR_BLOQUEADO,
  ERR_ACTUALIZAR_BLOQUEADO,
} = require('@/lib/rackly/errores')
const { cambiarEstadoGuia, cambiarEstadoAtencion } = require('@/lib/rackly/modulos')
const { atenderItemRq } = require('@/lib/rackly/rq-atencion')
const { atenderItemRal } = require('@/lib/rackly/ral')

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
const actualizacionBloqueada = (err) =>
  codigoControladoDe(err) === ERR_ACTUALIZAR_BLOQUEADO

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

  console.log('\n[6] piso.eliminarMovimiento — RPC atómica: el error del SERVIDOR se propaga')
  // Refactor mejoras-piso 20261107: el borrado es la RPC piso_eliminar_movimiento
  // (detalles + cabecera + snapshot en UNA transacción). La honestidad vive
  // server-side: la RPC RAISE si el movimiento no existe / fue filtrado por RLS
  // (DELETE 0 filas). El contrato del CLIENTE es propagar ese error, nunca
  // tragárselo (el éxito falso viejo era borrar cabecera sin ver filas).
  stub.__clear()
  stub.__setRpcResult('piso_eliminar_movimiento', {
    data: null,
    error: { message: 'Movimiento pm1 no encontrado', code: 'P0001' }, // RAISE real de la RPC
  })
  const errPm = await capturaError(() => eliminarMovimiento('pm1'))
  check('RPC falla (0 filas / inexistente) → eliminarMovimiento lanza', errPm !== null, JSON.stringify(errPm))
  const llamadaPm = stub.__rpcCalls().find((c) => c.name === 'piso_eliminar_movimiento')
  check('llama a piso_eliminar_movimiento con el id pedido', llamadaPm?.args?.p_movimiento_id === 'pm1', JSON.stringify(llamadaPm))
  stub.__setRpcResult('piso_eliminar_movimiento', { data: { success: true }, error: null })
  await eliminarMovimiento('pm1')
  check('RPC ok → resuelve sin error', true)

  console.log('\n[7] piso.eliminarMovimientoConPar — par por uuid_sync + RPC por cabecera')
  stub.__clear()
  stub.__setTable('piso_movimientos', [
    { id: 'pm1', uuid_sync: 'u1', tipo: 'salida' },
    { id: 'pm2', uuid_sync: 'u1', tipo: 'ingreso' },
  ])
  stub.__setRpcResult('piso_eliminar_movimiento', { data: { success: true }, error: null })
  stub.__setRpcResult('piso_eliminar_movimiento', { data: { success: true }, error: null })
  const nPar = await eliminarMovimientoConPar('pm1')
  check(`traslado completo devuelve 2 cabeceras: ${nPar}`, nPar === 2)
  const llamadasPar = stub.__rpcCalls().filter((c) => c.name === 'piso_eliminar_movimiento')
  check('2 llamadas RPC (salida + ingreso del par)', llamadasPar.length === 2, JSON.stringify(llamadasPar.map((c) => c.args)))
  // La RPC falla en la cabecera → el cliente LANZA (nunca «1 eliminada» falso).
  // El RAISE server-side cubre el caso que antes se verificaba client-side.
  stub.__clear()
  stub.__setTable('piso_movimientos', [{ id: 'pm3', uuid_sync: null, tipo: 'salida' }])
  stub.__setRpcResult('piso_eliminar_movimiento', {
    data: null,
    error: { message: 'Movimiento pm3 no encontrado', code: 'P0001' },
  })
  const errPar = await capturaError(() => eliminarMovimientoConPar('pm3'))
  check('RPC con error → lanza (no éxito falso)', errPar !== null, JSON.stringify(errPar))
  // Sin uuid_sync (movimiento simple) → 1 sola cabecera
  stub.__clear()
  stub.__setTable('piso_movimientos', [{ id: 'pm4', uuid_sync: null, tipo: 'salida' }])
  stub.__setRpcResult('piso_eliminar_movimiento', { data: { success: true }, error: null })
  const nSolo = await eliminarMovimientoConPar('pm4')
  check(`movimiento simple devuelve 1 cabecera: ${nSolo}`, nSolo === 1)

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

  // ─── Auditoría 2026-11-01: HONESTIDAD DE LOS UPDATE (clase espejo) ───
  console.log('\n[10] cambiarEstadoGuia / cambiarEstadoAtencion — 0 filas NO es éxito')
  stub.__clear()
  stub.__setTable('recepcion_registros', [{ id: 'r1' }, { id: 'r2' }])
  stub.__setUpdateData({ data: [], error: null }) // RLS filtró TODAS las filas
  const errGuia = await capturaError(() => cambiarEstadoGuia({ guiaId: 'g1' }, 'Observado'))
  check('guía: 0 filas de vuelta → ACTUALIZAR_BLOQUEADO', actualizacionBloqueada(errGuia), JSON.stringify(errGuia))
  stub.__setUpdateData({ data: [{ id: 'r1' }, { id: 'r2' }], error: null })
  await cambiarEstadoGuia({ guiaId: 'g1' }, 'Observado')
  check('guía: filas reales de vuelta → resuelve sin error', true)
  stub.__setUpdateData({ data: [{ id: 'a1' }], error: null })
  await cambiarEstadoAtencion('a1', 'Atendido')
  check('atención: 1 fila de vuelta → resuelve sin error', true)
  stub.__setUpdateData({ data: [], error: null })
  const errAten = await capturaError(() => cambiarEstadoAtencion('a1', 'Pendiente'))
  check('atención: 0 filas de vuelta → ACTUALIZAR_BLOQUEADO', actualizacionBloqueada(errAten), JSON.stringify(errAten))

  console.log('\n[11] recalcularEstadoRq/Ral — el encabezado filtrado ya no queda viejo')
  stub.__clear()
  const itemRq = {
    id: 'i1', rq_id: 'rq1', orden: 1, codigo: '118', descripcion: 'ACIDO', unidad: 'KGM',
    cantidad: 10, cantidad_atendida: 0, usuario_atencion: '', atendido_en: '',
  }
  stub.__setTable('rq_atencion_items', [itemRq])
  // La vía primaria es la RPC rq_atender_item (SECURITY DEFINER: dentro de la
  // BD no aplica RLS) — para llegar al RESPALDO cliente (donde sí filtra la
  // RLS) la RPC debe fallar primero.
  stub.__setRpcResult('rq_atender_item', { data: null, error: { message: 'RPC no disponible (test)' } })
  stub.__setUpdateResult({ data: itemRq, error: null }) // optimista: atiende OK
  stub.__setUpdateData({ data: [], error: null }) // encabezado RQ: RLS filtró
  const errRqHdr = await capturaError(() => atenderItemRq('i1', 5, 'Tester'))
  check('atender RQ con encabezado filtrado → ACTUALIZAR_BLOQUEADO', actualizacionBloqueada(errRqHdr), JSON.stringify(errRqHdr))
  stub.__setRpcResult('rq_atender_item', { data: null, error: { message: 'RPC no disponible (test)' } })
  stub.__setUpdateResult({ data: itemRq, error: null })
  stub.__setUpdateData({ data: [{ id: 'rq1' }], error: null })
  await atenderItemRq('i1', 3, 'Tester')
  check('atender RQ con encabezado real → resuelve sin error', true)
  const itemRal = {
    id: 'j1', ral_id: 'ra1', orden: 1, codigo: '5653', descripcion: 'FILM', unidad: 'UN',
    cantidad: 8, cantidad_atendida: 0, usuario_atencion: '', atendido_en: '',
  }
  stub.__setTable('ral_items', [itemRal])
  stub.__setRpcResult('ral_atender_item', { data: null, error: { message: 'RPC no disponible (test)' } })
  stub.__setUpdateResult({ data: itemRal, error: null })
  stub.__setUpdateData({ data: [], error: null })
  const errRalHdr = await capturaError(() => atenderItemRal('j1', 2, 'Tester'))
  check('atender RAL con encabezado filtrado → ACTUALIZAR_BLOQUEADO', actualizacionBloqueada(errRalHdr), JSON.stringify(errRalHdr))
  stub.__setRpcResult('ral_atender_item', { data: null, error: { message: 'RPC no disponible (test)' } })
  stub.__setUpdateResult({ data: itemRal, error: null })
  stub.__setUpdateData({ data: [{ id: 'ra1' }], error: null })
  await atenderItemRal('j1', 2, 'Tester')
  check('atender RAL con encabezado real → resuelve sin error', true)

  // ─── Resumen ───
  console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
  process.exit(fallidos > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
