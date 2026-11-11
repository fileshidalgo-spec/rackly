/**
 * RACKLY — Tests TRASLADO DE UBICACIÓN COMPLETA (funciones puras del cliente).
 *
 * Ejecutar (o bash scripts/run_all_tests.sh):
 *   npx esbuild scripts/test_traslado_ubicacion.js --bundle --platform=node \
 *     --alias:@=./src --outfile=scripts/.testbuild/test_traslado_ubicacion.cjs \
 *     --loader:.ts=ts --loader:.tsx=tsx --log-level=error \
 *     && node scripts/.testbuild/test_traslado_ubicacion.cjs
 *
 * Cubre el pedido del usuario 2026-11-11 (traslado de TODO el contenido de una
 * ubicación + ajustes por artículo: mover MENOS deja saldo, mover MÁS registra
 * ingreso de ajuste):
 *   - repartoFefoLotes: reparto FEFO multi-lote (fechas intactas), parcial,
 *     excedente → ajuste, un solo lote, sin lotes, anti-polvo flotante.
 *   - itemsTrasladoDesdeUbicacion: prefill total, edición manual, cantidad 0 =
 *     no mover, EXCLUSIÓN de INC (cuarentena), desglose de lotes por código.
 *   - parseTrasladoUbicacionError: códigos `XXX|detalle` de la RPC.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const {
  repartoFefoLotes,
  itemsTrasladoDesdeUbicacion,
  parseTrasladoUbicacionError,
  TrasladoUbicacionError,
} = require('@/lib/rackly/kardex.ts')

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

function eq(a, b, tol = 1e-9) {
  return Math.abs(a - b) < tol
}

function main() {
  // ═══ 1. repartoFefoLotes — reparto FEFO ═══
  console.log('\n1) repartoFefoLotes — mueve TODO un artículo multi-lote (fechas intactas)')
  {
    const lotes = [
      { fVencimiento: '2026-12-01', cantidad: 10 },
      { fVencimiento: '2027-01-15', cantidad: 5 },
    ]
    const r = repartoFefoLotes(15, lotes)
    check('2 tomas', r.tomas.length === 2, JSON.stringify(r))
    check('lote 1: 10 con su fecha', r.tomas[0].cantidad === 10 && r.tomas[0].fVencimiento === '2026-12-01')
    check('lote 2: 5 con su fecha', r.tomas[1].cantidad === 5 && r.tomas[1].fVencimiento === '2027-01-15')
    check('ajuste 0 (pedido = stock)', r.ajuste === 0)
  }

  console.log('\n2) repartoFefoLotes — parcial (mover MENOS deja saldo en origen)')
  {
    const lotes = [
      { fVencimiento: '2026-12-01', cantidad: 10 },
      { fVencimiento: '2027-01-15', cantidad: 5 },
    ]
    const r = repartoFefoLotes(12, lotes)
    check('2 tomas (10 + 2)', r.tomas.length === 2 && r.tomas[0].cantidad === 10 && r.tomas[1].cantidad === 2)
    check('quedan 3 sin toca (ajuste 0)', r.ajuste === 0)
    const r1 = repartoFefoLotes(3, [{ fVencimiento: '2026-12-01', cantidad: 10 }])
    check('parcial dentro de un lote: 3 del primero', r1.tomas.length === 1 && r1.tomas[0].cantidad === 3 && r1.ajuste === 0)
  }

  console.log('\n3) repartoFefoLotes — mover MÁS (físicamente hay más de lo registrado)')
  {
    const lotes = [
      { fVencimiento: '2026-12-01', cantidad: 10 },
      { fVencimiento: '2027-01-15', cantidad: 5 },
    ]
    const r = repartoFefoLotes(20, lotes)
    check('toma TODO (10 + 5)', r.tomas.length === 2 && eq(r.tomas[0].cantidad, 10) && eq(r.tomas[1].cantidad, 5))
    check('ajuste = 5 (lo que faltaba registrado)', eq(r.ajuste, 5), String(r.ajuste))
  }

  console.log('\n4) repartoFefoLotes — casos borde')
  {
    const r0 = repartoFefoLotes(5, [])
    check('sin lotes: todo va a ajuste', r0.tomas.length === 0 && eq(r0.ajuste, 5))
    const rU = repartoFefoLotes(3, [{ fVencimiento: '', cantidad: 8 }])
    check('lote sin fecha: toma 3 con fVenc vacío', rU.tomas.length === 1 && rU.tomas[0].cantidad === 3 && rU.tomas[0].fVencimiento === '')
    const rF = repartoFefoLotes(0.1 + 0.2, [{ fVencimiento: '2026-12-01', cantidad: 0.3 }])
    check('anti-polvo flotante: 0.3 exacto consume el lote', rF.tomas.length === 1 && eq(rF.tomas[0].cantidad, 0.3) && rF.ajuste === 0)
    const rOrden = repartoFefoLotes(2, [
      { fVencimiento: '2027-06-01', cantidad: 4 },
      { fVencimiento: '2026-05-01', cantidad: 4 },
    ])
    check('FEFO respeta orden aunque la lista venga desordenada', rOrden.tomas[0].fVencimiento === '2026-05-01')
  }

  // ═══ 5. itemsTrasladoDesdeUbicacion ═══
  console.log('\n5) itemsTrasladoDesdeUbicacion — prefill, edición, INC y lotes')
  {
    const contenido = [
      { codigo: 'AAA', descripcion: 'Art A', un: 'UND', stock: 15, fVencimiento: '2026-12-01',
        lotes: [{ fVencimiento: '2026-12-01', cantidad: 10 }, { fVencimiento: '2027-02-01', cantidad: 5 }] },
      { codigo: 'BBB', descripcion: 'Art B', un: 'KG', stock: 4.5 },
      { codigo: 'CCC', descripcion: 'Art INC', un: 'UND', stock: 7, codigoInc: 'INC-001' },
      { codigo: 'DDD', descripcion: 'Art D', un: 'UND', stock: 3 },
    ]
    const cantidades = { AAA: '15', BBB: '2.5', CCC: '7', DDD: '0' }
    const r = itemsTrasladoDesdeUbicacion(contenido, cantidades)
    check('2 items (DDD en 0 y CCC INC no se mueven)', r.items.length === 2, JSON.stringify(r.items))
    check('AAA prefill total 15', r.items.find((i) => i.codigo === 'AAA').cantidad === 15)
    check('BBB edición manual 2.5', r.items.find((i) => i.codigo === 'BBB').cantidad === 2.5)
    check('CCC (INC) excluido', !r.items.some((i) => i.codigo === 'CCC'))
    check('omitidosInc = [CCC]', r.omitidosInc.length === 1 && r.omitidosInc[0].codigo === 'CCC')
    check('lotesPorCodigo solo AAA (multi-lote)', r.lotesPorCodigo.AAA?.length === 2 && !r.lotesPorCodigo.BBB)
    const rDefault = itemsTrasladoDesdeUbicacion(contenido, {})
    check('sin edición: todo prefill total', rDefault.items.length === 3 && rDefault.items.find((i) => i.codigo === 'BBB').cantidad === 4.5 && rDefault.items.find((i) => i.codigo === 'DDD').cantidad === 3)
  }

  // ═══ 6. parseTrasladoUbicacionError ═══
  console.log('\n6) parseTrasladoUbicacionError — códigos de negocio de la RPC')
  {
    const e1 = parseTrasladoUbicacionError('SIN_STOCK_ORIGEN|Artículo XYZ sin stock en la ubicación de origen')
    check('SIN_STOCK_ORIGEN detectado', e1 instanceof TrasladoUbicacionError && e1.code === 'SIN_STOCK_ORIGEN')
    check('detalle legible', e1 && e1.detail.includes('XYZ'))
    const e2 = parseTrasladoUbicacionError('SAME_ORIGIN_DESTINATION|El destino no puede ser igual al origen')
    check('SAME_ORIGIN_DESTINATION detectado', e2 && e2.code === 'SAME_ORIGIN_DESTINATION')
    check('error ajeno → null', parseTrasladoUbicacionError('Connection refused') === null)
    check('mensaje de permiso', parseTrasladoUbicacionError('NO_AUTORIZADO|No tienes permiso')?.code === 'NO_AUTORIZADO')
  }

  // ═══ RESULTADO ═══
  console.log(`\n${'═'.repeat(40)}`)
  console.log(`RESULTADO: ${passed} pasados, ${failed} fallidos`)
  if (failed > 0) process.exit(1)
}

main()
