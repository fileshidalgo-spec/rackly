/**
 * RACKLY · Tests REPUESTOS — Atención/Tránsito: RPCs del flujo de salida.
 *
 * Usa el STUB de Supabase: verifica que las 4 RPCs (rep_pickear_linea,
 * rep_despachar_ral, rep_devolver_linea, rep_anular_ral) se invocan con
 * los parámetros correctos y que los errores controlados de BD llegan
 * legibles al operario. Los transiciona el kardex, no la UI.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const {
  repPickearLinea,
  repDespacharRal,
  repDevolverLinea,
  repAnularRal,
  repTransitoDeRal,
  repPrepickings,
} = require('@/lib/rackly/rep/rep-client')
const { mensajeError } = require('@/lib/rackly/errores')

let ok = 0
function check(nombre, cond, detalle = '') {
  if (cond) {
    ok++
    console.log(`  ✓ ${nombre}`)
  } else {
    console.error(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`)
    process.exitCode = 1
  }
}

const DET = '33333333-3333-4333-8333-333333333333'
const RAL = '44444444-4444-4444-8444-444444444444'
const PP_LON = '55555555-5555-4555-8555-555555555555'

async function main() {
  // ── [1] Picking: parámetros correctos + respuesta mapeada ──
  console.log('\n[1] rep_pickear_linea')
  stub.__clear()
  stub.__setRpcResult('rep_pickear_linea', {
    data: { ok: true, prepicking: 'PP-P1-N1', cantidad: 5, tomado_de_almacen: 5, faltante: 0 },
    error: null,
  })
  const pk = await repPickearLinea(DET, PP_LON)
  const pkCalls = stub.__rpcCalls().filter((c) => c.name === 'rep_pickear_linea')
  check('RPC invocada con detalle + lonchera prepicking', pkCalls.length === 1 && pkCalls[0].args.p_detalle_id === DET && pkCalls[0].args.p_prepicking_lonchera_id === PP_LON)
  check('respuesta: prepicking PP-P1-N1, sin faltante', pk.prepicking === 'PP-P1-N1' && pk.faltante === 0)

  // Picking con faltante de stock (aviso, no bloquea)
  stub.__clear()
  stub.__setRpcResult('rep_pickear_linea', {
    data: { ok: true, prepicking: 'PP-P1-N1', cantidad: 5, tomado_de_almacen: 3, faltante: 2 },
    error: null,
  })
  const pk2 = await repPickearLinea(DET)
  check('faltante honesto (tomado 3 de 5)', pk2.tomadoDeAlmacen === 3 && pk2.faltante === 2)
  check('sin lonchera explícita → null (BD elige)', stub.__rpcCalls()[0].args.p_prepicking_lonchera_id === null)

  // ── [2] Despacho: salida completa + estado ──
  console.log('\n[2] rep_despachar_ral')
  stub.__clear()
  stub.__setRpcResult('rep_despachar_ral', { data: { ok: true, lineas: 3, cantidad: 14 }, error: null })
  const dp = await repDespacharRal(RAL)
  check('RPC invocada con p_ral_id', stub.__rpcCalls().some((c) => c.name === 'rep_despachar_ral' && c.args.p_ral_id === RAL))
  check('resumen: 3 líneas · 14 unidades', dp.lineas === 3 && dp.cantidad === 14)

  // ── [3] Devolución de línea + anulación ──
  console.log('\n[3] rep_devolver_linea · rep_anular_ral')
  stub.__clear()
  stub.__setRpcResult('rep_devolver_linea', { data: { ok: true, destino: 'R-P1-N2-P05' }, error: null })
  const dv = await repDevolverLinea(DET)
  check('devolución → destino R-P1-N2-P05', dv.destino === 'R-P1-N2-P05')
  stub.__setRpcResult('rep_anular_ral', { data: { ok: true }, error: null })
  await repAnularRal(RAL)
  check('anulación RPC con p_ral_id', stub.__rpcCalls().some((c) => c.name === 'rep_anular_ral' && c.args.p_ral_id === RAL))

  // ── [4] Errores controlados legibles ──
  console.log('\n[4] Errores de la BD → detalle legible')
  const CASOS = [
    ['rep_pickear_linea', 'LINEA_YA_PICKEADA|La línea ya está en Tránsito (picking ya registrado)', 'ya está en Tránsito'],
    ['rep_pickear_linea', 'PREPICKING_NO_EXISTE|No hay ninguna ubicación de pre-picking: créala en Ubicaciones', 'pre-picking'],
    ['rep_pickear_linea', 'RAL_NO_REGISTRADO|El RAL RAL-9 ya no está registrado (estado: despachado)', 'ya no está registrado'],
    ['rep_despachar_ral', 'RAL_SIN_CARGA|El RAL RAL-9 no tiene artículos en pre-picking: registra el picking en Atención', 'no tiene artículos en pre-picking'],
    ['rep_despachar_ral', 'RAL_ESTADO_INVALIDO|El RAL RAL-9 ya está despachado', 'ya está despachado'],
    ['rep_devolver_linea', 'LINEA_NO_EN_TRANSITO|La línea no está en Tránsito (nada que devolver)', 'nada que devolver'],
    ['rep_devolver_linea', 'SIN_LONCHERA_DESTINO|El artículo no tiene lonchera de origen: recíbelo por Recepción', 'lonchera de origen'],
    ['rep_anular_ral', 'RAL_CON_CARGA|El RAL tiene artículos en Tránsito: devuélvelos antes de anular', 'devuélvelos antes de anular'],
  ]
  for (const [fn, raw, esperado] of CASOS) {
    stub.__clear()
    stub.__setRpcResult(fn, { data: null, error: { message: raw } })
    const wrapper =
      fn === 'rep_pickear_linea' ? () => repPickearLinea(DET)
      : fn === 'rep_despachar_ral' ? () => repDespacharRal(RAL)
      : fn === 'rep_devolver_linea' ? () => repDevolverLinea(DET)
      : () => repAnularRal(RAL)
    let msg = ''
    try { await wrapper() } catch (e) { msg = mensajeError(e) }
    check(`${fn}: "${raw.split('|')[0]}" → legible`, msg.includes(esperado), `mensaje="${msg}"`)
  }

  // ── [5] Lecturas derivadas: tránsito y prepickings ──
  console.log('\n[5] Tránsito de un RAL + lista de prepickings')
  stub.__clear()
  stub.__setTable('rep_stock', [
    { cantidad: 5, articulo: { id: 'a-1', codigo: 'X-1' } },
    { cantidad: 2, articulo: { id: 'a-2', codigo: 'X-2' } },
  ])
  const tr = await repTransitoDeRal(RAL)
  check('2 filas en tránsito', tr.length === 2 && tr[0].codigo === 'X-1' && tr[0].cantidad === 5)
  stub.__setTable('rep_ubicaciones', [
    { id: 'u-pp', codigo: 'PP-P1-N1', nota: 'zona salida', loncheras: [{ id: 'L-1' }] },
    { id: 'u-pp2', codigo: 'PP-P1-N2', nota: '', loncheras: [] },
  ])
  const pps = await repPrepickings()
  check('solo prepickings con lonchera', pps.length === 1 && pps[0].loncheraId === 'L-1' && pps[0].codigo === 'PP-P1-N1')

  // ── Resumen ──
  console.log(`\n════════ RESULTADO: ${ok} pasados ════════`)
  if (process.exitCode !== 1) console.log('OK test_rep_atencion')
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
