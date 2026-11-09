/**
 * RACKLY · Tests REPUESTOS — Recepción: RPC atómica rep_registrar_ingreso.
 *
 * Usa el STUB de Supabase: verifica que la recepción llama a la RPC con
 * los parámetros correctos (artículo, lonchera, cantidad, referencia) y
 * que los errores controlados de BD (LONCHERA_LLENA, ARTICULO_INACTIVO,
 * NO_AUTORIZADO, CANTIDAD_INVALIDA) llegan legibles al operario vía
 * mensajeError (la convención "CODE|detalle" muestra SOLO el detalle).
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const { repRegistrarIngreso, repArticuloPorCodigo } = require('@/lib/rackly/rep/rep-client')
const { mensajeError, codigoControladoDe } = require('@/lib/rackly/errores')

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

const ART = '11111111-1111-4111-8111-111111111111'
const LON = '22222222-2222-4222-8222-222222222222'

async function main() {
  // ── [1] Camino feliz: la RPC recibe los parámetros correctos ──
  console.log('\n[1] Registro de ingreso (RPC atómica)')
  stub.__clear()
  stub.__setRpcResult('rep_registrar_ingreso', {
    data: {
      ok: true,
      movimiento_id: 'mov-1',
      ubicacion: 'R-P1-N2-P05',
      lado: 'A',
      en_otra_lonchera: null,
    },
    error: null,
  })
  const res = await repRegistrarIngreso({
    articuloId: ART,
    loncheraId: LON,
    cantidad: 12,
    referencia: 'OC-7788',
  })
  const calls = stub.__rpcCalls().filter((c) => c.name === 'rep_registrar_ingreso')
  check('1 llamada a rep_registrar_ingreso', calls.length === 1)
  check('p_articulo_id correcto', calls[0].args.p_articulo_id === ART)
  check('p_lonchera_id correcto', calls[0].args.p_lonchera_id === LON)
  check('p_cantidad = 12', calls[0].args.p_cantidad === 12)
  check('p_referencia = "OC-7788"', calls[0].args.p_referencia === 'OC-7788')
  check('respuesta mapeada: ubicacion R-P1-N2-P05 lado A', res.ubicacion === 'R-P1-N2-P05' && res.lado === 'A')
  check('sin aviso de otra lonchera', res.enOtraLonchera === null)

  // ── [2] Aviso "ya vive en otra lonchera" (excepción controlada) ──
  console.log('\n[2] Aviso no bloqueante de lonchera única')
  stub.__clear()
  stub.__setRpcResult('rep_registrar_ingreso', {
    data: {
      ok: true,
      movimiento_id: 'mov-2',
      ubicacion: 'R-P1-N3-P01',
      lado: 'B',
      en_otra_lonchera: { lado: 'A', ubicacion: 'R-P1-N2-P05' },
    },
    error: null,
  })
  const res2 = await repRegistrarIngreso({ articuloId: ART, loncheraId: LON, cantidad: 5 })
  check('aviso presente', res2.enOtraLonchera?.ubicacion === 'R-P1-N2-P05' && res2.enOtraLonchera?.lado === 'A')
  check('ingreso igualmente exitoso', res2.ubicacion === 'R-P1-N3-P01')

  // ── [3] Errores controlados de BD: legibles para el operario ──
  console.log('\n[3] Errores controlados (CODE|detalle → solo detalle)')
  const CASOS = [
    ['LONCHERA_LLENA|La lonchera R-P1-N2-P05 ya tiene 15 artículos distintos', 'ya tiene 15 artículos'],
    ['ARTICULO_INACTIVO|El artículo está inactivo en el catálogo', 'está inactivo'],
    ['NO_AUTORIZADO|No tienes permiso para registrar ingresos en Repuestos', 'No tienes permiso'],
    ['CANTIDAD_INVALIDA|La cantidad debe ser mayor que cero', 'mayor que cero'],
    ['LONCHERA_NO_EXISTE|La lonchera destino no existe', 'lonchera destino no existe'],
  ]
  for (const [raw, esperado] of CASOS) {
    stub.__clear()
    stub.__setRpcResult('rep_registrar_ingreso', { data: null, error: { message: raw } })
    let msg = ''
    try {
      await repRegistrarIngreso({ articuloId: ART, loncheraId: LON, cantidad: 1 })
    } catch (e) {
      msg = mensajeError(e)
    }
    check(`"${raw.split('|')[0]}" → detalle legible`, msg.includes(esperado), `mensaje="${msg}"`)
    check(`"${raw.split('|')[0]}" no filtra código al usuario`, !msg.startsWith(raw.split('|')[0]))
  }

  // ── [4] Búsqueda por código: normaliza antes de consultar ──
  console.log('\n[4] repArticuloPorCodigo normaliza el código')
  stub.__clear()
  stub.__setTable('rep_articulos', [
    { id: ART, codigo: 'BJ-109-003', descripcion: 'Filtro de aire', und: 'UND', cantidad_ref: 4, marca: '', modelo: '', aplicacion: '', activo: true, created_at: '', updated_at: '' },
  ])
  const a = await repArticuloPorCodigo('  bj-109-003 ')
  check('encontrado con código sucio (trim + mayúsculas)', a?.codigo === 'BJ-109-003')
  await repArticuloPorCodigo('INEXISTENTE-99')
  // El stub responde la primera fila sin aplicar eq: lo verificable es que
  // la consulta filtró por el código NORMALIZADO (comportamiento del builder).
  const eqCodigo = stub.__eqCalls().filter((c) => c.table === 'rep_articulos' && c.col === 'codigo').map((c) => c.val)
  check('consulta filtró con código normalizado', eqCodigo.includes('BJ-109-003') && eqCodigo.includes('INEXISTENTE-99'), JSON.stringify(eqCodigo))

  // ── Resumen ──
  console.log(`\n════════ RESULTADO: ${ok} pasados ════════`)
  if (process.exitCode !== 1) console.log('OK test_rep_recepcion')
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
