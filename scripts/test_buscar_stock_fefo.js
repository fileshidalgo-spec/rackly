/**
 * RACKLY — Tests Buscar Stock FEFO (Módulo Racks, pestaña Buscar Stock).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_buscar_stock_fefo.js --bundle --platform=node \
 *     --alias:@=/home/z/my-project/rackly/src --external:xlsx,react,@supabase/ssr \
 *     --outfile=scripts/.testbuild/test_buscar_stock.cjs --loader:.ts=ts --loader:.tsx=tsx \
 *     && node scripts/.testbuild/test_buscar_stock.cjs
 *
 * Regresión v3.4 (denuncia del usuario):
 *   - "no está dando la información correcta con respecto a los proveedores de
 *     lámina termocontraible" → proveedorPorVenc: proveedor del lote remanente.
 *   - "debería aparecer el más próximo a vencer" → compararFEFO: orden FEFO.
 *
 * NOTA 2026-11-09: las secciones que ejercitaban calcularStockRacksDesdeMovs
 * (lotes antiguos / multi-proveedor / orden / INC+desborde) se retiraron junto
 * con la función: era el núcleo de la búsqueda cruzada antigua (sin llamadores
 * desde el desacople 442e7da; el panel cruzado actual consulta la RPC
 * server-side stock_por_codigo_kardex). El núcleo FEFO sigue cubierto por la
 * sección de calcularLotesRemanentes (fuente única de remanentes).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const {
  proveedorPorVenc,
  compararFEFO,
  compararUbicacionNum,
  calcularLotesRemanentes,
} = require('@/lib/rackly/kardex.ts')

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ═══ 1. compararFEFO — el más próximo a vencer primero, S/F al final ═══
console.log('\n1) compararFEFO')
check('fecha menor primero', compararFEFO('2026-10-20', '2027-01-01') < 0)
check('fecha mayor después', compararFEFO('2027-05-16', '2027-05-09') > 0)
check('iguales = 0', compararFEFO('2027-05-09', '2027-05-09') === 0)
check('con fecha antes que sin fecha', compararFEFO('2027-01-01', '') < 0)
check('sin fecha después que con fecha', compararFEFO('', '2027-01-01') > 0)
check('ambas sin fecha = 0', compararFEFO('', '') === 0)

// ═══ 2. compararUbicacionNum — orden numérico con ceros a la izquierda ═══
console.log('\n2) compararUbicacionNum')
check('bloque 2 < bloque 10', compararUbicacionNum(
  { bloque: '2', torre: '1', piso: '1', posicion: '1' },
  { bloque: '10', torre: '1', piso: '1', posicion: '1' }) < 0)
check('cero a la izquierda tolerado (02 == 2)', compararUbicacionNum(
  { bloque: '02', torre: '1', piso: '1', posicion: '1' },
  { bloque: '2', torre: '1', piso: '1', posicion: '1' }) === 0)
check('desempata por posición', compararUbicacionNum(
  { bloque: '2', torre: '2', piso: '2', posicion: '6' },
  { bloque: '2', torre: '2', piso: '2', posicion: '16' }) < 0)

// ═══ 3. proveedorPorVenc — proveedor del ingreso MÁS RECIENTE de cada lote ═══
console.log('\n3) proveedorPorVenc')
{
  // Caso real 53308 pos 3-1-2-9: lote viejo UNION PLAST consumido, restante DAMAR
  const entradas = [
    { venc: '2027-09-08', proveedor: 'UNION PLAST', ts: '2026-06-01T10:00' },
    { venc: '2027-09-27', proveedor: 'DAMAR', ts: '2026-09-20T10:00' },
  ]
  const map = proveedorPorVenc(entradas)
  check('lote viejo → UNION PLAST', map.get('2027-09-08') === 'UNION PLAST')
  check('lote nuevo → DAMAR', map.get('2027-09-27') === 'DAMAR')

  // Mismo venc, dos proveedores: gana el más reciente (FIFO dentro del lote)
  const map2 = proveedorPorVenc([
    { venc: '2027-01-01', proveedor: 'INCOMIN', ts: '2026-01-01T00:00' },
    { venc: '2027-01-01', proveedor: 'DAMAR', ts: '2026-06-01T00:00' },
  ])
  check('mismo venc 2 proveedores → el más reciente', map2.get('2027-01-01') === 'DAMAR')

  // Ingresos sin proveedor NO pisan el mapa (no contaminan con vacío)
  const map3 = proveedorPorVenc([
    { venc: '2027-01-01', proveedor: 'DAMAR', ts: '2026-01-01T00:00' },
    { venc: '2027-01-01', proveedor: undefined, ts: '2026-02-01T00:00' },
  ])
  check('ingreso sin proveedor no pisa al que sí tiene', map3.get('2027-01-01') === 'DAMAR')

  // Mapa vacío si ningún ingreso trae proveedor
  check('sin proveedores → mapa vacío', proveedorPorVenc([{ venc: '2027-01-01', ts: '2026-01-01' }]).size === 0)
}

// ═══ 4. calcularLotesRemanentes sigue íntegro (regresión del núcleo) ═══
console.log('\n4) calcularLotesRemanentes — núcleo sin cambios')
{
  const ing = new Map([['2027-05-09', 370.48], ['2027-05-16', 362.3]])
  const rem = calcularLotesRemanentes(ing, [{ venc: '2027-05-09', qty: 370.48 }])
  check('remanentes: 1 lote 2027-05-16', rem.length === 1 && rem[0].venc === '2027-05-16' && rem[0].cantidad === 362.3,
        JSON.stringify(rem))
}

console.log(`\n════════════════════════════════════`)
console.log(`BUSCAR STOCK FEFO: ${passed} pasaron, ${failed} fallaron`)
if (failed > 0) process.exit(1)
