/**
 * RACKLY — Tests unitarios del generador de rótulos ZPL (src/lib/rackly/zebra.ts).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_zebra_zpl.js --bundle --platform=node --outfile=/tmp/test_zebra.cjs --alias:@=/home/z/rackly/src --loader:.ts=ts --loader:.tsx=tsx && node /tmp/test_zebra.cjs
 *
 * Escenarios:
 *   1. Estructura ZPL válida (^XA … ^XZ, ^CI28, dimensiones por tamaño).
 *   2. Datos del artículo presentes (código, barcode ^BC, descripción, cantidad).
 *   3. Copias (^PQ) y múltiples rótulos.
 *   4. Saneo de caracteres peligrosos (^ ~ \ y caracteres de control).
 *   5. Fechas ISO → dd/mm/yyyy.
 *   6. Tildes/ñ se conservan (^CI28 UTF-8).
 */

const {
  construirZPLRotulo,
  construirZPLRotulos,
  sanearZPL,
} = require('@/lib/rackly/zebra')

let passed = 0
let failed = 0

function check(nombre, cond) {
  if (cond) {
    passed++
    console.log(`  ✓ ${nombre}`)
  } else {
    failed++
    console.error(`  ✗ FALLO: ${nombre}`)
  }
}

const ENCABEZADO = {
  fecha: '2026-10-09',
  numeroDocumento: 'T173-00004090',
  proveedor: 'AJER S.A.',
  placa: 'C9G7B1',
  registradoPor: 'Miguel Hidalgo',
}

const DATOS = {
  codigo: '11688',
  descripcion: 'ALCOHOL ETÍLICO 96°',
  cantidad: '24',
  unidad: 'BG',
  lote: 'L12345',
  fechaProduccion: '2026-09-01',
  fechaVencimiento: '2027-09-01',
}

console.log('\n── 1. Estructura ZPL (4x6) ──')
const z1 = construirZPLRotulo(DATOS, ENCABEZADO, { tamano: '4x6', copias: 2 })
check('empieza con ^XA', z1.startsWith('^XA'))
check('termina con ^XZ', z1.trimEnd().endsWith('^XZ'))
check('UTF-8 (^CI28)', z1.includes('^CI28'))
check('ancho 812 dots', z1.includes('^PW812'))
check('largo 1218 dots', z1.includes('^LL1218'))
check('Code128 del código', z1.includes('^BCN,110,Y,N,N^FD11688^FS'))
check('código como texto', z1.includes('^FD11688^FS'))

console.log('\n── 2. Contenido del rótulo ──')
check('descripción presente', z1.includes('ALCOHOL ETÍLICO 96°'))
check('cantidad + unidad', z1.includes('24 BG'))
check('lote', z1.includes('LOTE: L12345'))
check('fecha producción dd/mm/yyyy', z1.includes('F. PRODUCCION: 01/09/2026'))
check('fecha vencimiento dd/mm/yyyy', z1.includes('F. VENCIMIENTO: 01/09/2027'))
check('guía', z1.includes('GUIA: T173-00004090'))
check('placa', z1.includes('PLACA: C9G7B1'))
check('proveedor', z1.includes('PROVEEDOR: AJER S.A.'))
check('registrado por', z1.includes('REGISTRO: Miguel Hidalgo'))
check('fecha de recepción', z1.includes('09/10/2026'))

console.log('\n── 3. Copias y múltiples rótulos ──')
check('2 copias (^PQ2)', z1.includes('^PQ2,0,0,N'))
const z1c = construirZPLRotulo(DATOS, ENCABEZADO) // default 1 copia
check('1 copia por defecto', z1c.includes('^PQ1,0,0,N'))
const DATOS2 = { ...DATOS, codigo: '56119', descripcion: 'TETRA BRIK 145ML' }
const zMulti = construirZPLRotulos([DATOS, DATOS2], [1, 3], ENCABEZADO, '4x6')
check('2 etiquetas (2 ^XA)', (zMulti.match(/\^XA/g) || []).length === 2)
check('copias por rótulo (1 y 3)', zMulti.includes('^PQ1,0,0,N') && zMulti.includes('^PQ3,0,0,N'))

console.log('\n── 4. Saneo ZPL ──')
check('^ reemplazado', sanearZPL('A^B') === 'A B')
check('~ reemplazado', sanearZPL('A~B') === 'A B')
check('\\ reemplazado', sanearZPL('A\\B') === 'A B')
check('control chars reemplazados por espacio', sanearZPL('A\x01\x1fB') === 'A  B' && !/[\x00-\x1f\x7f]/.test(sanearZPL('A\x01\x1fB')))
const zInj = construirZPLRotulo(
  { ...DATOS, descripcion: 'MAL^XA^FDFALSO^XZ' },
  ENCABEZADO
)
check('inyección ZPL neutralizada en descripción', !zInj.includes('FALSO^XZ'))

console.log('\n── 5. Tamaño compacto 4x2 ──')
const z2 = construirZPLRotulo(DATOS, ENCABEZADO, { tamano: '4x2', copias: 1 })
check('ancho 812 dots', z2.includes('^PW812'))
check('largo 406 dots', z2.includes('^LL406'))
check('código presente', z2.includes('11688'))
check('Code128 presente', z2.includes('^BC'))
check('sin comandos fuera de ^XA…^XZ', z2.startsWith('^XA') && z2.trimEnd().endsWith('^XZ'))

console.log('\n── 6. Tildes/ñ con ^CI28 ──')
const zAcc = construirZPLRotulo(
  { ...DATOS, descripcion: 'PURÉ DE DURAZNO ÑANDÚ 30-32 ºBRIX' },
  ENCABEZADO
)
check('é conservada', zAcc.includes('PURÉ'))
check('Ñ conservada', zAcc.includes('ÑANDÚ'))
check('º conservado', zAcc.includes('ºBRIX'))

console.log(`\n═══ RESULTADO: ${passed} pasados, ${failed} fallados ═══`)
process.exit(failed > 0 ? 1 : 0)
