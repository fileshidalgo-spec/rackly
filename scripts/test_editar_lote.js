/**
 * RACKLY — Tests de EDICIÓN de lote/fecha de vencimiento (Racks + Piso).
 * Pedido 2026-10-20: artículos sin lote/fechas deben poder modificarse y
 * guardarse (cargo almacenero). Ampliación del mismo día: la edición
 * también alcanza artículos QUE YA TIENEN lote/fechas (corregir
 * equivocaciones) y los cargos se amplían a supervisores.
 *
 * Ejecutar:
 *   npx esbuild scripts/test_editar_lote.js --bundle --platform=node \
 *     --alias:@=./src --alias:@/lib/supabase/client=./scripts/stubs/supabase_client_stub.js \
 *     --external:xlsx,react,@supabase/ssr,sonner \
 *     --outfile=scripts/.testbuild/test_editar_lote.cjs --loader:.ts=ts --loader:.tsx=tsx \
 *     && node scripts/.testbuild/test_editar_lote.cjs
 *
 * Cobertura (TODO con stub, sin red):
 *   1. puedeEditarLote — almacenero/admin/supervisores SÍ; operario/
 *      auxiliar/coordinador/sin-rol NO.
 *   2. validarDatosLote — acepta lote, acepta fecha, exige al menos uno,
 *      rechaza fecha no-ISO y lote >100 chars; normaliza TRIM y vacío→null.
 *   3. construirOpcionesLote — descompone filas de stock en buckets exactos
 *      (lote físico × fecha): fila simple sin datos, con lote único, con
 *      "L1, L2" bajo una misma fecha, y desglose multi-fecha con/sin
 *      lotesFisicos. SIEMPRE devuelve al menos una opción.
 *   4. editarLoteVencimientoRacks — normaliza args (código UPPER, vacío→null),
 *      envía lote_actual/fecha_actual (v2) y propaga errores RPC.
 *   5. editarLoteVencimientoPiso — normaliza args, envía valores actuales y
 *      propaga errores igual.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const supabaseStub = require('@/lib/supabase/client')
const { puedeEditarLote, validarDatosLote, construirOpcionesLote, etiquetaOpcionLote, calcularAjusteCantidad } = require('@/lib/rackly/lote.ts')
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
  check('supervisor_almacen SÍ puede (ampliación v2)', puedeEditarLote('supervisor_almacen') === true)
  check('supervisor_operaciones SÍ puede (ampliación v2)', puedeEditarLote('supervisor_operaciones') === true)
  check('operario NO puede', puedeEditarLote('operario') === false)
  check('auxiliar NO puede', puedeEditarLote('auxiliar') === false)
  check('coordinador_operaciones NO puede', puedeEditarLote('coordinador_operaciones') === false)
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

  console.log('— 3. construirOpcionesLote (desambiguación de buckets v2) —')
  // 3a. Fila sin datos: una sola opción vacía → prefill directo (flujo v1)
  const opSinDatos = construirOpcionesLote({ stock: 10 })
  check('fila sin datos → 1 opción (sin lote, sin fecha)', opSinDatos.length === 1 && opSinDatos[0].loteFisico === '' && opSinDatos[0].fecha === '')
  // 3b. Fila simple con fecha y lote único → 1 opción prellenada (corrección directa)
  const opSimple = construirOpcionesLote({ stock: 5, fecha: '2027-01-31', loteFisico: 'L-1' })
  check('fila simple con datos → 1 opción (L-1, 2027-01-31)', opSimple.length === 1 && opSimple[0].loteFisico === 'L-1' && opSimple[0].fecha === '2027-01-31')
  // 3c. Fila con DOS lotes físicos bajo una MISMA fecha → 2 opciones (selector)
  const opDobles = construirOpcionesLote({ stock: 9, fecha: '2027-01-31', loteFisico: 'L-1, L-2' })
  check('"L-1, L-2" bajo una fecha → 2 opciones', opDobles.length === 2)
  check('opciones con lotes separados y misma fecha', opDobles.some(o => o.loteFisico === 'L-1') && opDobles.some(o => o.loteFisico === 'L-2') && opDobles.every(o => o.fecha === '2027-01-31'))
  // 3d. Desglose multi-fecha con lotesFisicos → una opción por lote físico
  const opMulti = construirOpcionesLote({
    stock: 30,
    lotes: [
      { fVencimiento: '2027-01-31', cantidad: 10, lotesFisicos: ['L-1'] },
      { fVencimiento: '2027-06-30', cantidad: 20, lotesFisicos: ['L-3', 'L-4'] },
    ],
  })
  check('multi-fecha → 1 + 2 = 3 opciones', opMulti.length === 3)
  check('fechas respetadas por opción', opMulti.filter(o => o.fecha === '2027-01-31').length === 1 && opMulti.filter(o => o.fecha === '2027-06-30').length === 2)
  // 3e. Desglose multi-fecha SIN lotesFisicos → opción por fecha con lote ''
  const opMultiSinFis = construirOpcionesLote({
    stock: 30,
    lotes: [
      { fVencimiento: '2027-01-31', cantidad: 10 },
      { fVencimiento: '', cantidad: 20 },
    ],
  })
  check('multi-fecha sin lotes físicos → 2 opciones con lote ""', opMultiSinFis.length === 2 && opMultiSinFis.every(o => o.loteFisico === ''))
  // 3f. Etiqueta legible
  check('etiquetaOpcionLote con lote y fecha', etiquetaOpcionLote({ loteFisico: 'L-1', fecha: '2027-01-31', cantidad: 1 }) === 'Lote: L-1 · Venc: 2027-01-31')
  check('etiquetaOpcionLote sin datos', etiquetaOpcionLote({ loteFisico: '', fecha: '', cantidad: 1 }) === 'Sin lote · Sin fecha')
  // 3g. Normalización: espacios y entradas vacías
  const opNorm = construirOpcionesLote({ stock: 1, fecha: ' 2027-01-31 ', loteFisico: ' L-7 , L-8 ' })
  check('normaliza trim y filtra vacíos', opNorm.length === 2 && opNorm[0].loteFisico === 'L-7' && opNorm[1].loteFisico === 'L-8' && opNorm[0].fecha === '2027-01-31')

  console.log('— 4. editarLoteVencimientoRacks (args → RPC) —')
  rpcCalls.length = 0
  const resR = await editarLoteVencimientoRacks({
    bloque: '2', torre: '3', piso: '1', posicion: '04',
    codigo: ' abc123 ', lote: ' LOTE-9 ', fVencimiento: ' 2027-01-31 ',
  })
  check('RPC llamada con nombre correcto', rpcCalls[0]?.fn === 'editar_lote_vencimiento_racks')
  let argsR = rpcCalls[0]?.args ?? {}
  check('código normalizado a UPPER/TRIM', argsR.p_codigo === 'ABC123')
  check('lote TRIM', argsR.p_lote === 'LOTE-9')
  check('fecha TRIM', argsR.p_f_vencimiento === '2027-01-31')
  check('bucket actual vacío viaja como NULL (flujo v1)', argsR.p_lote_actual === null && argsR.p_f_vencimiento_actual === null)
  check('ubicación viaja completa', argsR.p_bloque === '2' && argsR.p_torre === '3' && argsR.p_piso === '1' && argsR.p_posicion === '04')
  check('resultado expone filas_actualizadas', resR.filasActualizadas === 1 && resR.lote === 'L-1')

  // v2: corrección — el bucket ACTUAL viaja a la RPC
  rpcCalls.length = 0
  await editarLoteVencimientoRacks({
    bloque: '2', torre: '3', piso: '1', posicion: '04',
    codigo: 'ABC123', lote: 'L-CORRECTO', fVencimiento: '2027-06-30',
    loteActual: ' L-MAL ', fVencimientoActual: '2027-01-31',
  })
  argsR = rpcCalls[0]?.args ?? {}
  check('lote_actual TRIM (corrección v2)', argsR.p_lote_actual === 'L-MAL')
  check('f_vencimiento_actual viaja (corrección v2)', argsR.p_f_vencimiento_actual === '2027-01-31')

  // Campos vacíos nuevos viajan como null (la RPC decide SIN_DATOS)
  rpcCalls.length = 0
  await editarLoteVencimientoRacks({ bloque: '2', torre: '3', piso: '1', posicion: '04', codigo: 'ABC123' })
  check('lote/fecha nuevos vacíos → null (defensa en servidor)', rpcCalls[0].args.p_lote === null && rpcCalls[0].args.p_f_vencimiento === null)

  // Error de la RPC se propaga con el detalle
  rpcHandler = () => Promise.resolve({ data: null, error: { message: 'SIN_FILAS|No hay stock con esos datos para ABC123 en esa ubicación (puede que ya se haya corregido)' } })
  try {
    await editarLoteVencimientoRacks({ bloque: '2', torre: '3', piso: '1', posicion: '04', codigo: 'ABC123', lote: 'X' })
    check('error SIN_FILAS se propaga', false, 'no lanzó')
  } catch (e) {
    check('error SIN_FILAS se propaga', /SIN_FILAS/.test(e.message))
  }
  rpcHandler = null

  console.log('— 5. editarLoteVencimientoPiso (args → RPC) —')
  rpcCalls.length = 0
  const resP = await editarLoteVencimientoPiso({
    posicionId: 'uuid-pos', bloqueId: 'uuid-bloque', lote: ' L-PISO ', fVencimiento: '',
  })
  check('RPC llamada con nombre correcto', rpcCalls[0]?.fn === 'editar_lote_vencimiento_piso')
  let argsP = rpcCalls[0]?.args ?? {}
  check('posicion_id + bloque_id viajan', argsP.p_posicion_id === 'uuid-pos' && argsP.p_bloque_id === 'uuid-bloque')
  check('lote TRIM y fecha vacía → null', argsP.p_lote === 'L-PISO' && argsP.p_f_vencimiento === null)
  check('bucket actual vacío viaja como NULL (flujo v1)', argsP.p_lote_actual === null && argsP.p_f_vencimiento_actual === null)
  check('resultado expone filas_actualizadas', resP.filasActualizadas === 1)

  // v2: corrección en Piso
  rpcCalls.length = 0
  await editarLoteVencimientoPiso({
    posicionId: 'uuid-pos', bloqueId: 'uuid-bloque',
    lote: 'L-BUENO', fVencimiento: '2027-08-15',
    loteActual: 'L-MALO', fVencimientoActual: '2027-01-31',
  })
  argsP = rpcCalls[0]?.args ?? {}
  check('lote_actual + fecha_actual viajan (corrección v2 Piso)', argsP.p_lote_actual === 'L-MALO' && argsP.p_f_vencimiento_actual === '2027-01-31')

  rpcHandler = () => Promise.resolve({ data: null, error: { message: 'SIN_DATOS|Indique el lote y/o la fecha de vencimiento del producto' } })
  try {
    await editarLoteVencimientoPiso({ posicionId: 'p', bloqueId: 'b' })
    check('error SIN_DATOS se propaga', false, 'no lanzó')
  } catch (e) {
    check('error SIN_DATOS se propaga', /SIN_DATOS/.test(e.message))
  }
  rpcHandler = null

  // ── 6. calcularAjusteCantidad (Task 28 — corrección de cantidad en Racks) ──
  console.log('— 6. calcularAjusteCantidad (ajuste compensatorio del kardex) —')
  const a1 = calcularAjusteCantidad(100, 90)
  check('nueva < actual → SALIDA de 10', a1.tipo === 'salida' && a1.cantidad === 10)
  const a2 = calcularAjusteCantidad(100, 125)
  check('nueva > actual → INGRESO de 25', a2.tipo === 'ingreso' && a2.cantidad === 25)
  const a3 = calcularAjusteCantidad(100, 100)
  check('igual → sin ajuste', a3.tipo === null && a3.cantidad === 0)
  const a4 = calcularAjusteCantidad(100.0000001, 100)
  check('tolerancia (delta se redondea a 0 a 3 decimales) → sin ajuste', a4.tipo === null)
  const a5 = calcularAjusteCantidad(100.5, 100.25)
  check('decimales → salida de 0.25 (3 decimales)', a5.tipo === 'salida' && Math.abs(a5.cantidad - 0.25) < 1e-9)
  const a6 = calcularAjusteCantidad(100, 0)
  check('nueva 0 → salida total del bucket', a6.tipo === 'salida' && a6.cantidad === 100)
  const a7 = calcularAjusteCantidad(100, NaN)
  check('NaN → sin ajuste (defensivo, la UI valida antes)', a7.tipo === null)
  const a8 = calcularAjusteCantidad(50, 50.0004)
  check('delta < 0.001 se redondea a sin ajuste', a8.tipo === null)

  // proveedor hereda a las opciones (para el ajuste tipo ingreso)
  const opsProv = construirOpcionesLote({ stock: 10, fecha: '2027-01-31', loteFisico: 'L1', proveedor: 'PROV-A' })
  check('opción hereda el proveedor de la fila (ajuste ingreso conserva identidad)', opsProv[0]?.proveedor === 'PROV-A')
  const opsProvLote = construirOpcionesLote({
    stock: 10,
    lotes: [
      { fVencimiento: '2027-01-31', cantidad: 6, lotesFisicos: ['L1'], proveedor: 'PROV-L1' },
      { fVencimiento: '2027-06-30', cantidad: 4 },
    ],
    proveedor: 'PROV-FILA',
  })
  check('proveedor del LOTE manda sobre el de la fila', opsProvLote[0]?.proveedor === 'PROV-L1')
  check('lote sin proveedor hereda el de la fila', opsProvLote[1]?.proveedor === 'PROV-FILA')

  console.log('────────────────────────────')
  console.log(`editar_lote: ${passed} OK · ${failed} FAIL`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
