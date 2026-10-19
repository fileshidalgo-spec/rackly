/**
 * RACKLY — Tests de EDICIÓN de lote/fecha de vencimiento (Racks + Piso).
 * Pedido 2026-10-20: artículos sin lote/fechas deben poder modificarse y
 * guardarse cuando el usuario tiene cargo almacenero (y admin conserva).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_editar_lote.js --bundle --platform=node \
 *     --alias:@=./src --alias:@/lib/supabase/client=./scripts/stubs/supabase_client_stub.js \
 *     --external:xlsx,react,@supabase/ssr,sonner \
 *     --outfile=scripts/.testbuild/test_editar_lote.cjs --loader:.ts=ts --loader:.tsx=tsx \
 *     && node scripts/.testbuild/test_editar_lote.cjs
 *
 * Cobertura (TODO con stub, sin red):
 *   1. puedeEditarLote — almacenero/admin SÍ; operario/auxiliar/supervisor/sin-rol NO.
 *   2. validarDatosLote — acepta lote, acepta fecha, exige al menos uno,
 *      rechaza fecha no-ISO y lote >100 chars; normaliza TRIM y vacío→null.
 *   3. editarLoteVencimientoRacks — normaliza args (código UPPER, vacío→null)
 *      y propaga el mensaje de error de la RPC (SIN_FILAS/SIN_DATOS).
 *   4. editarLoteVencimientoPiso — normaliza args y propaga errores igual.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const supabaseStub = require('@/lib/supabase/client')
const { puedeEditarLote, validarDatosLote } = require('@/lib/rackly/lote.ts')
const { editarLoteVencimientoRacks } = require('@/lib/rackly/kardex.ts')
const { editarLoteVencimientoPiso } = require('@/lib/piso/api.ts')

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ═══ Instrumentación del stub: capturar llamadas rpc ═══
const rpcCalls = []
let rpcHandler = null
supabaseStub.dataClient.rpc = (fn, args) => {
  rpcCalls.push({ fn, args })
  if (rpcHandler) return rpcHandler(fn, args)
  return Promise.resolve({ data: { success: true, filas_actualizadas: 1, lote: 'L-1', f_vencimiento: '2027-01-31' }, error: null })
}

async function main() {
  console.log('— 1. Rol puedeEditarLote —')
  check('almacenero SÍ puede editar', puedeEditarLote('almacenero') === true)
  check('admin SÍ puede editar', puedeEditarLote('admin') === true)
  check('operario NO puede', puedeEditarLote('operario') === false)
  check('auxiliar NO puede', puedeEditarLote('auxiliar') === false)
  check('supervisor_almacen NO puede (alcance pedido: almacenero)', puedeEditarLote('supervisor_almacen') === false)
  check('sin rol NO puede', puedeEditarLote(null) === false && puedeEditarLote(undefined) === false)

  console.log('— 2. validarDatosLote —')
  const soloLote = validarDatosLote('  AP-123  ', null)
  check('solo lote OK y normalizado (trim)', soloLote.ok && soloLote.lote === 'AP-123' && soloLote.fecha === null)
  const soloFecha = validarDatosLote('', '2027-01-31')
  check('solo fecha OK', soloFecha.ok && soloFecha.lote === null && soloFecha.fecha === '2027-01-31')
  const ambos = validarDatosLote('L-9', '2027-06-30')
  check('lote + fecha OK', ambos.ok && ambos.lote === 'L-9' && ambos.fecha === '2027-06-30')
  const vacio = validarDatosLote('   ', '')
  check('ambos vacíos → rechazo SIN_DATOS', !vacio.ok && /lote/i.test(vacio.error))
  const fechaMala = validarDatosLote('L-1', '31/01/2027')
  check('fecha no ISO → rechazo', !fechaMala.ok && /AAAA-MM-DD/i.test(fechaMala.error))
  const loteLargo = validarDatosLote('x'.repeat(101), null)
  check('lote >100 chars → rechazo', !loteLargo.ok && /100/.test(loteLargo.error))

  console.log('— 3. editarLoteVencimientoRacks (args → RPC) —')
  rpcCalls.length = 0
  const resR = await editarLoteVencimientoRacks({
    bloque: '2', torre: '3', piso: '1', posicion: '04',
    codigo: ' abc123 ', lote: ' LOTE-9 ', fVencimiento: ' 2027-01-31 ',
  })
  check('RPC llamada con nombre correcto', rpcCalls[0]?.fn === 'editar_lote_vencimiento_racks')
  const argsR = rpcCalls[0]?.args ?? {}
  check('código normalizado a UPPER/TRIM', argsR.p_codigo === 'ABC123')
  check('lote TRIM', argsR.p_lote === 'LOTE-9')
  check('fecha TRIM', argsR.p_f_vencimiento === '2027-01-31')
  check('ubicación viaja completa', argsR.p_bloque === '2' && argsR.p_torre === '3' && argsR.p_piso === '1' && argsR.p_posicion === '04')
  check('resultado expone filas_actualizadas', resR.filasActualizadas === 1 && resR.lote === 'L-1')
  // Campos vacíos viajan como null (la RPC decide SIN_DATOS)
  rpcCalls.length = 0
  await editarLoteVencimientoRacks({ bloque: '2', torre: '3', piso: '1', posicion: '04', codigo: 'ABC123' })
  check('lote/fecha vacíos → null (defensa en servidor)', rpcCalls[0].args.p_lote === null && rpcCalls[0].args.p_f_vencimiento === null)
  // Error de la RPC se propaga con el detalle
  rpcHandler = () => Promise.resolve({ data: null, error: { message: 'SIN_FILAS|No hay stock sin lote y sin fecha para ABC123 en esa ubicación' } })
  try {
    await editarLoteVencimientoRacks({ bloque: '2', torre: '3', piso: '1', posicion: '04', codigo: 'ABC123', lote: 'X' })
    check('error SIN_FILAS se propaga', false, 'no lanzó')
  } catch (e) {
    check('error SIN_FILAS se propaga', /SIN_FILAS/.test(e.message))
  }
  rpcHandler = null

  console.log('— 4. editarLoteVencimientoPiso (args → RPC) —')
  rpcCalls.length = 0
  const resP = await editarLoteVencimientoPiso({
    posicionId: 'uuid-pos', bloqueId: 'uuid-bloque', lote: ' L-PISO ', fVencimiento: '',
  })
  check('RPC llamada con nombre correcto', rpcCalls[0]?.fn === 'editar_lote_vencimiento_piso')
  const argsP = rpcCalls[0]?.args ?? {}
  check('posicion_id + bloque_id viajan', argsP.p_posicion_id === 'uuid-pos' && argsP.p_bloque_id === 'uuid-bloque')
  check('lote TRIM y fecha vacía → null', argsP.p_lote === 'L-PISO' && argsP.p_f_vencimiento === null)
  check('resultado expone filas_actualizadas', resP.filasActualizadas === 1)
  rpcHandler = () => Promise.resolve({ data: null, error: { message: 'SIN_DATOS|Indique el lote y/o la fecha de vencimiento del producto' } })
  try {
    await editarLoteVencimientoPiso({ posicionId: 'p', bloqueId: 'b' })
    check('error SIN_DATOS se propaga', false, 'no lanzó')
  } catch (e) {
    check('error SIN_DATOS se propaga', /SIN_DATOS/.test(e.message))
  }
  rpcHandler = null

  console.log('────────────────────────────')
  console.log(`editar_lote: ${passed} OK · ${failed} FAIL`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
