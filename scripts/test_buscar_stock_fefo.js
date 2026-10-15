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
 *   - "jalan lotes antiguos" → calcularStockRacksDesdeMovs: f_vencimiento del
 *     PRIMER LOTE REMANENTE (no el mínimo histórico con lotes ya consumidos).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const {
  proveedorPorVenc,
  compararFEFO,
  compararUbicacionNum,
  calcularStockRacksDesdeMovs,
  calcularLotesRemanentes,
} = require('@/lib/rackly/kardex.ts')

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

function mov(over) {
  return {
    id: over.id || 'm' + Math.random().toString(36).slice(2),
    tipo: over.tipo,
    bloque: over.bloque, torre: over.torre, piso: over.piso, posicion: over.posicion,
    codigo: over.codigo, descripcion: over.descripcion || 'LAMINA TERMOCONTRAIBLE',
    un: over.un || 'KG', cantidad: over.cantidad,
    fVencimiento: over.fVencimiento || '',
    fModificacion: over.fModificacion,
    turno: 'DIA', usuarioId: 'u1',
    proveedor: over.proveedor, codigoInc: over.codigoInc, lote: over.lote,
  }
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

// ═══ 4. calcularStockRacksDesdeMovs — el lote antiguo consumido NO se muestra ═══
console.log('\n4) calcularStockRacksDesdeMovs (caso real 15240 / pos 3-1-3-15)')
{
  // Ingresos 2026-06-25: 370.48 @2027-05-09 + 362.3 @2027-05-16 (DAMAR).
  // Salida 2026-09-29: 370.48 dirigida a @2027-05-09 (lote agotado).
  // BUG histórico: la pestaña mostraba fVenc=2027-05-09 (lote YA CONSUMIDO).
  const movs = [
    mov({ tipo: 'ingreso', bloque: '3', torre: '1', piso: '3', posicion: '15', codigo: '15240',
          cantidad: 370.48, fVencimiento: '2027-05-09', fModificacion: '2026-06-25T13:06', proveedor: 'DAMAR' }),
    mov({ tipo: 'ingreso', bloque: '3', torre: '1', piso: '3', posicion: '15', codigo: '15240',
          cantidad: 362.3, fVencimiento: '2027-05-16', fModificacion: '2026-06-25T13:06', proveedor: 'DAMAR' }),
    mov({ tipo: 'salida', bloque: '3', torre: '1', piso: '3', posicion: '15', codigo: '15240',
          cantidad: 370.48, fVencimiento: '2027-05-09', fModificacion: '2026-09-29T15:59' }),
  ]
  const rows = calcularStockRacksDesdeMovs(movs)
  check('1 fila con stock', rows.length === 1, `got ${rows.length}`)
  check('stock neto 362.3', rows[0].stock === 362.3, `got ${rows[0].stock}`)
  check('fVencimiento = lote REMANENTE 2027-05-16 (no el consumido 2027-05-09)',
        rows[0].fVencimiento === '2027-05-16', `got ${rows[0].fVencimiento}`)
  check('proveedor del lote remanente', rows[0].proveedor === 'DAMAR', `got ${rows[0].proveedor}`)
}

// ═══ 5. Multi-proveedor: proveedor del lote que QUEDA, no el histórico ═══
console.log('\n5) calcularStockRacksDesdeMovs (caso real 53308 / pos 3-1-2-9)')
{
  // Lote viejo UNION PLAST @2027-09-08 consumido; lote nuevo DAMAR @2027-09-27 queda.
  // BUG histórico: mostraba prov=UNION PLAST y fVenc=2027-09-08 (lote consumido).
  const movs = [
    mov({ tipo: 'ingreso', bloque: '3', torre: '1', piso: '2', posicion: '9', codigo: '53308',
          cantidad: 844.8, fVencimiento: '2027-09-08', fModificacion: '2026-05-10T10:00', proveedor: 'UNION PLAST' }),
    mov({ tipo: 'salida', bloque: '3', torre: '1', piso: '2', posicion: '9', codigo: '53308',
          cantidad: 844.8, fVencimiento: '2027-09-08', fModificacion: '2026-08-01T10:00' }),
    mov({ tipo: 'ingreso', bloque: '3', torre: '1', piso: '2', posicion: '9', codigo: '53308',
          cantidad: 844.8, fVencimiento: '2027-09-27', fModificacion: '2026-09-20T10:00', proveedor: 'DAMAR' }),
  ]
  const rows = calcularStockRacksDesdeMovs(movs)
  check('1 fila', rows.length === 1)
  check('fVencimiento = 2027-09-27 (lote remanente)', rows[0].fVencimiento === '2027-09-27', `got ${rows[0].fVencimiento}`)
  check('proveedor = DAMAR (no UNION PLAST)', rows[0].proveedor === 'DAMAR', `got ${rows[0].proveedor}`)
}

// ═══ 6. Orden del listado: más próximo a vencer PRIMERO, S/F al final ═══
console.log('\n6) calcularStockRacksDesdeMovs orden FEFO')
{
  const movs = [
    // Posición con lote S/F (debe ir AL FINAL)
    mov({ tipo: 'ingreso', bloque: '5', torre: '1', piso: '1', posicion: '1', codigo: '53524',
          cantidad: 100, fVencimiento: '', fModificacion: '2026-01-01T00:00', proveedor: 'DAMAR' }),
    // Posición con lote lejano
    mov({ tipo: 'ingreso', bloque: '2', torre: '2', piso: '1', posicion: '13', codigo: '53524',
          cantidad: 200, fVencimiento: '2027-09-26', fModificacion: '2026-01-02T00:00', proveedor: 'INCOMIN' }),
    // Posición con lote más próximo (debe ir PRIMERA aunque su ubicación sea mayor)
    mov({ tipo: 'ingreso', bloque: '3', torre: '1', piso: '2', posicion: '9', codigo: '53524',
          cantidad: 300, fVencimiento: '2027-04-06', fModificacion: '2026-01-03T00:00', proveedor: 'DIAMAND' }),
  ]
  const rows = calcularStockRacksDesdeMovs(movs)
  check('3 filas', rows.length === 3)
  check('1ª = la más próxima a vencer (2027-04-06)', rows[0].fVencimiento === '2027-04-06', rows[0].fVencimiento)
  check('2ª = la siguiente fecha (2027-09-26)', rows[1].fVencimiento === '2027-09-26', rows[1].fVencimiento)
  check('última = sin fecha', rows[2].fVencimiento === '', rows[2].fVencimiento)
}

// ═══ 7. INC excluido del stock normal + salidas desbordan FEFO ═══
console.log('\n7) INC excluido + desborde FEFO')
{
  const movs = [
    // Stock normal: 100 @A + 100 @B, salida dirigida a B por 150 → quedan 50 @A
    mov({ tipo: 'ingreso', bloque: '1', torre: '1', piso: '1', posicion: '1', codigo: 'X1',
          cantidad: 100, fVencimiento: '2027-01-01', fModificacion: '2026-01-01T00:00', proveedor: 'P1' }),
    mov({ tipo: 'ingreso', bloque: '1', torre: '1', piso: '1', posicion: '1', codigo: 'X1',
          cantidad: 100, fVencimiento: '2027-06-01', fModificacion: '2026-01-02T00:00', proveedor: 'P2' }),
    mov({ tipo: 'salida', bloque: '1', torre: '1', piso: '1', posicion: '1', codigo: 'X1',
          cantidad: 150, fVencimiento: '2027-06-01', fModificacion: '2026-02-01T00:00' }),
    // INC: NO debe contar en el stock normal
    mov({ tipo: 'ingreso', bloque: '1', torre: '1', piso: '1', posicion: '1', codigo: 'X1',
          cantidad: 999, fVencimiento: '2027-01-01', fModificacion: '2026-03-01T00:00', codigoInc: 'INC-1' }),
  ]
  const rows = calcularStockRacksDesdeMovs(movs)
  check('INC excluido: stock = 50 (no 1049)', rows.length === 1 && rows[0].stock === 50,
        `got ${JSON.stringify(rows)}`)
  check('fVencimiento = 2027-01-01 (lote A que absorbió el desborde)',
        rows[0].fVencimiento === '2027-01-01', `got ${rows[0].fVencimiento}`)
  // Proveedor: lote A (FEFO remanente) es de P1, aunque el primer movimiento también era P1
  check('proveedor del lote remanente A', rows[0].proveedor === 'P1', `got ${rows[0].proveedor}`)

  // Desborde con proveedor distinto en el lote absorbido: A=P1, B=P2, salida dirigida a B
  // consume B y desborda sobre A → remanente A con proveedor P1 (el correcto)
  const movs2 = [
    mov({ tipo: 'ingreso', bloque: '1', torre: '1', piso: '1', posicion: '2', codigo: 'X1',
          cantidad: 100, fVencimiento: '2027-01-01', fModificacion: '2026-01-01T00:00', proveedor: 'P1' }),
    mov({ tipo: 'ingreso', bloque: '1', torre: '1', piso: '1', posicion: '2', codigo: 'X1',
          cantidad: 100, fVencimiento: '2027-06-01', fModificacion: '2026-01-02T00:00', proveedor: 'P2' }),
    mov({ tipo: 'salida', bloque: '1', torre: '1', piso: '1', posicion: '2', codigo: 'X1',
          cantidad: 30, fVencimiento: '2027-06-01', fModificacion: '2026-02-01T00:00' }),
  ]
  const rows2 = calcularStockRacksDesdeMovs(movs2)
  check('desborde parcial: 2 lotes remanentes', rows2.length === 1)
  check('fVenc = 2027-01-01 (FEFO)', rows2[0].fVencimiento === '2027-01-01', `got ${rows2[0].fVencimiento}`)
  check('proveedor = P1', rows2[0].proveedor === 'P1', `got ${rows2[0].proveedor}`)
}

// ═══ 8. calcularLotesRemanentes sigue íntegro (regresión del núcleo) ═══
console.log('\n8) calcularLotesRemanentes — núcleo sin cambios')
{
  const ing = new Map([['2027-05-09', 370.48], ['2027-05-16', 362.3]])
  const rem = calcularLotesRemanentes(ing, [{ venc: '2027-05-09', qty: 370.48 }])
  check('remanentes: 1 lote 2027-05-16', rem.length === 1 && rem[0].venc === '2027-05-16' && rem[0].cantidad === 362.3,
        JSON.stringify(rem))
}

console.log(`\n════════════════════════════════════`)
console.log(`BUSCAR STOCK FEFO: ${passed} pasaron, ${failed} fallaron`)
if (failed > 0) process.exit(1)
