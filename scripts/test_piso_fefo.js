/**
 * RACKLY — Tests FEFO Piso (Módulo PISO).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_piso_fefo.js --bundle --platform=node \
 *     --alias:@=/home/z/my-project/rackly/src \
 *     --alias:@/lib/supabase/client=/home/z/my-project/rackly/scripts/stubs/supabase_client_stub.js \
 *     --external:xlsx,react,@supabase/ssr \
 *     --outfile=scripts/.testbuild/test_piso_fefo.cjs --loader:.ts=ts --loader:.tsx=tsx \
 *     && node scripts/.testbuild/test_piso_fefo.cjs
 *
 * Regresión (denuncia del usuario, Módulo Piso):
 *   - "los lotes están quedándose pegados de ingresos anteriores" → stockPisoGlobal /
 *     stockPisoBuscar ahora usan FEFO DIRIGIDO (salida descuenta SU lote primero,
 *     desborde FEFO) en vez de FEFO puro — 19 grupos reales divergían de Sectores.
 *   - "artículos que aparecen en 0 pero no desaparecen" → lotesRestantesPorBloque
 *     redondea a 3 decimales antes del filtro > 0 (sin lotes fantasma) y las
 *     salidas se validan contra el stock REAL (validarStockSuficiente).
 *   - "no hay una pestaña FEFO" → FefoPisoTab (mismo motor de datos, probado aquí).
 *   - "al buscar carga toda la base de datos" → stockPisoBuscar: consulta
 *     server-side solo los bloques que matchean (se prueba mapeo y orden).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const supabaseStub = require('@/lib/supabase/client')
const {
  lotesRestantesPorBloque,
  stockPisoBuscar,
} = require('@/lib/piso/api.ts')

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// Helper: filas PLANAS (PisoDetalleRow) — el formato que consumen los callers de
// lotesRestantesPorBloque tras aplanar el JOIN (ver pisoDetalleTipo/pisoDetalleFecha).
function row(bloqueId, cantidad, fv, tipo, fechaMov) {
  return { bloque_id: bloqueId, cantidad, fecha_vencimiento: fv, tipo, fechaMov }
}

function main() {
  // ═══ 1. lotesRestantesPorBloque — FEFO DIRIGIDO (fuente única de verdad) ═══
  console.log('\n1) lotesRestantesPorBloque — dirigido + desborde FEFO')
  {
    // Caso real 104553e9/e5541cfa: ingreso viejo 100 (2026-11-17), ingreso nuevo
    // 300 (2027-01-31), SALIDA DIRIGIDA al lote nuevo (100).
    // FEFO puro antiguo daba {2027-01-31: 400} — el lote viejo "pegado".
    const filas = [
      row('B1', 100, '2026-11-17', 'ingreso', '2026-06-01T10:00'),
      row('B1', 300, '2027-01-31', 'ingreso', '2026-09-20T10:00'),
      row('B1', 100, '2027-01-31', 'salida', '2026-10-01T10:00'),
    ]
    const rem = lotesRestantesPorBloque(filas).get('B1') ?? []
    check('salida dirigida NO toca el lote viejo (2 lotes restantes)', rem.length === 2, JSON.stringify(rem))
    check('lote viejo 2026-11-17 intacto con 100', rem.find((r) => r.fecha === '2026-11-17')?.qty === 100)
    check('lote nuevo 2027-01-31 queda con 200', rem.find((r) => r.fecha === '2027-01-31')?.qty === 200)
    check('orden FEFO: viejo primero', rem[0]?.fecha === '2026-11-17')
  }

  console.log('\n2) lotesRestantesPorBloque — desborde FEFO cuando el dirigido no alcanza')
  {
    const filas = [
      row('B1', 100, '2026-11-17', 'ingreso', '2026-06-01T10:00'),
      row('B1', 300, '2027-01-31', 'ingreso', '2026-09-20T10:00'),
      row('B1', 350, '2027-01-31', 'salida', '2026-10-01T10:00'),
    ]
    const rem = lotesRestantesPorBloque(filas).get('B1') ?? []
    check('lote nuevo agotado y desborda 50 al viejo', rem.length === 1 && rem[0].fecha === '2026-11-17' && rem[0].qty === 50, JSON.stringify(rem))
  }

  console.log('\n3) lotesRestantesPorBloque — salida SIN fecha descuenta el lote sin fecha primero')
  {
    const filas = [
      row('B1', 50, '', 'ingreso', '2026-05-01T10:00'),
      row('B1', 100, '2027-01-01', 'ingreso', '2026-06-01T10:00'),
      row('B1', 30, '', 'salida', '2026-07-01T10:00'),
    ]
    const rem = lotesRestantesPorBloque(filas).get('B1') ?? []
    check('lote sin fecha queda con 20', rem.find((r) => r.fecha === '')?.qty === 20, JSON.stringify(rem))
    check('lote con fecha intacto', rem.find((r) => r.fecha === '2027-01-01')?.qty === 100)
  }

  console.log('\n4) lotesRestantesPorBloque — sin negativos y suma conservada')
  {
    const filas = [
      row('B1', 10, '2027-03-01', 'ingreso', '2026-01-01T00:00'),
      row('B1', 25, '2027-02-01', 'ingreso', '2026-01-02T00:00'),
      row('B1', 30, '2027-03-01', 'salida', '2026-01-03T00:00'),
      row('B1', 2, '', 'salida', '2026-01-04T00:00'),
    ]
    const rem = lotesRestantesPorBloque(filas).get('B1') ?? []
    const total = rem.reduce((s, r) => s + r.qty, 0)
    check('ningún lote negativo', rem.every((r) => r.qty > 0), JSON.stringify(rem))
    check('suma = ingresos - salidas (35-32=3)', Math.round(total * 1000) / 1000 === 3, `total=${total}`)
    check('desborde correcto: salida dirigida a 2027-03-01 (10) desborda 20 a 2027-02-01 (25), luego salida sin fecha 2 → solo queda 2027-02-01 con 3',
      rem.length === 1 && rem[0].fecha === '2027-02-01' && rem[0].qty === 3, JSON.stringify(rem))
  }

  console.log('\n5) lotesRestantesPorBloque — residuos float NO dejan lotes fantasma en 0')
  {
    // Caso documentado en código: 30.780+30.780+82.080 menos salidas FEFO dejaba ~1e-14
    const filas = [
      row('B1', 30.780, '2026-12-26', 'ingreso', '2026-01-01T00:00'),
      row('B1', 30.780, '2026-12-26', 'ingreso', '2026-01-02T00:00'),
      row('B1', 82.080, '2026-12-26', 'ingreso', '2026-01-03T00:00'),
      row('B1', 143.640, '2026-12-26', 'salida', '2026-02-01T00:00'),
    ]
    const rem = lotesRestantesPorBloque(filas)
    check('lote consumido al 100% desaparece (no queda "0 pegado")', !rem.has('B1') || rem.get('B1').length === 0)
  }

  console.log('\n6) lotesRestantesPorBloque — salida dirigida a lote específico lo agota')
  {
    const filas = [
      row('B1', 100, '2027-01-31', 'ingreso', '2026-09-20T10:00'),
      row('B1', 100, '2026-11-17', 'ingreso', '2026-06-01T10:00'),
      row('B1', 100, '2026-11-17', 'salida', '2026-10-01T10:00'),
    ]
    const rem = lotesRestantesPorBloque(filas).get('B1') ?? []
    check('salida dirigida a 2026-11-17 lo agota; queda solo el nuevo',
      rem.length === 1 && rem[0].fecha === '2027-01-31' && rem[0].qty === 100, JSON.stringify(rem))
  }

  console.log('\n7) Consistencia del caso real 0495ec5c (salida dirigida al lote más viejo)')
  {
    // Ingresos 60.3 (04-24), 33.3 (08-05), 5.1 (05-27); salida 30.4 DIRIGIDA a 04-24.
    // Esperado: 04-24 queda 29.9; total 68.3.
    const filas = [
      row('B9', 60.3, '2027-04-24', 'ingreso', '2026-05-01T00:00'),
      row('B9', 33.3, '2027-08-05', 'ingreso', '2026-05-02T00:00'),
      row('B9', 5.1, '2027-05-27', 'ingreso', '2026-05-03T00:00'),
      row('B9', 30.4, '2027-04-24', 'salida', '2026-06-01T00:00'),
    ]
    const rem = lotesRestantesPorBloque(filas).get('B9') ?? []
    const total = Math.round(rem.reduce((s, r) => s + r.qty, 0) * 1000) / 1000
    check('lote 2027-04-24 queda con 29.9 (dirigido)', rem.find((r) => r.fecha === '2027-04-24')?.qty === 29.9, JSON.stringify(rem))
    check('total conservado = 68.3', total === 68.3, `total=${total}`)
    check('orden FEFO: 04-24 < 05-27 < 08-05', JSON.stringify(rem.map((r) => r.fecha)) === JSON.stringify(['2027-04-24', '2027-05-27', '2027-08-05']))
  }
}

async function mainAsync() {
  // ═══ 8. stockPisoBuscar — mapeo dirigido + orden + INC (con stub Supabase) ═══
  console.log('\n8) stockPisoBuscar — búsqueda server-side mapea lotes REALES (dirigido)')
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
    { bloque_id: 'B1', nivel_id: 'N1', cantidad: 100, fecha_vencimiento: '2027-01-31',
      piso_movimientos: { tipo: 'salida', codigo_inc: null, fecha: '2026-10-01T10:00:00+00:00' }, piso_niveles: LOC },
  ])

  const items = await stockPisoBuscar('48035')
  check('2 lotes reales (NO el lote viejo pegado del FEFO puro)', items.length === 2, JSON.stringify(items))
  check('más próximo a vencer primero (2026-11-17)', items[0]?.fecha_vencimiento === '2026-11-17')
  check('cantidad del lote próximo: 100', items[0]?.cantidad === 100)
  check('segundo lote 2027-01-31 con 200', items[1]?.fecha_vencimiento === '2027-01-31' && items[1]?.cantidad === 200)
  check('codigo_inc propagado del ingreso de ese lote', items[1]?.codigo_inc === 'INC-7')
  check('ubicación resuelta con JOIN profundo', items[0]?.ubicacion === 'A-A1-Pos 3', items[0]?.ubicacion)
  check('sector resuelto', items[0]?.sector_nombre === 'Sector 1')
  check('unidad del bloque', items[0]?.bloque_unidad === 'KG')

  console.log('\n9) stockPisoBuscar — término vacío / sanitización')
  const vacio = await stockPisoBuscar('   ')
  check('término vacío → sin resultados', Array.isArray(vacio) && vacio.length === 0)
  const conComa = await stockPisoBuscar('LAMINA,GRANDE')
  check('término con coma no rompe (se sanitiza)', Array.isArray(conComa))
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
