/**
 * RACKLY — Tests unitarios del generador de rótulos ZPL (src/lib/rackly/zebra.ts).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_zebra_zpl.js --bundle --platform=node --outfile=/tmp/test_zebra.cjs --alias:@=/home/z/my-project/rackly/src --loader:.ts=ts --loader:.tsx=tsx && node /tmp/test_zebra.cjs
 *
 * FORMATO: etiqueta PERECIBLE de la empresa (plantilla Excel), 10 × 15 cm.
 *
 * Escenarios:
 *   1. Estructura ZPL válida (^XA…^XZ, ^CI28, 800×1200 dots, marco).
 *   2. Fidelidad a la plantilla: SIN barcode, SIN guía/placa/proveedor,
 *      etiquetas LOTE:/F.P/F.V/CANT:, fechas dd/mm/yyyy.
 *   3. Copias (^PQ) y múltiples rótulos.
 *   4. Saneo de caracteres peligrosos (^ ~ \ y control) + anti-inyección.
 *   5. Tildes/ñ/º se conservan (^CI28 UTF-8).
 *   6. Campos vacíos → celdas en blanco sin crash.
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

// Caso real de la plantilla PERECIBLE (código 56119)
const DATOS = {
  codigo: '56119',
  descripcion: 'ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 145 ML - DISEÑO 202',
  cantidad: '193320',
  unidad: 'UN',
  lote: '0869051017',
  fechaProduccion: '2026-07-23',
  fechaVencimiento: '2027-07-22',
}

console.log('\n── 1. Estructura ZPL (10×15 cm) ──')
const z1 = construirZPLRotulo(DATOS, ENCABEZADO, { copias: 2 })
check('empieza con ^XA', z1.startsWith('^XA'))
check('termina con ^XZ', z1.trimEnd().endsWith('^XZ'))
check('UTF-8 (^CI28)', z1.includes('^CI28'))
check('ancho 800 dots (10 cm)', z1.includes('^PW800'))
check('largo 1200 dots (15 cm)', z1.includes('^LL1200'))
check('marco exterior 800×1200', z1.includes('^GB800,1200,3'))
check('código gigante (alto 200)', z1.includes('^A0N,200,120'))
check('código presente como texto', z1.includes('^FD56119^FS'))

console.log('\n── 2. Fidelidad a la plantilla PERECIBLE ──')
check('SIN código de barras (^BC)', !z1.includes('^BC'))
check('SIN "GUIA:"', !z1.includes('GUIA:'))
check('SIN "PLACA:"', !z1.includes('PLACA:'))
check('SIN "PROVEEDOR:"', !z1.includes('PROVEEDOR:'))
check('etiqueta LOTE:', z1.includes('^FDLOTE:^FS'))
check('etiqueta F.P', z1.includes('^FDF.P^FS'))
check('etiqueta F.V', z1.includes('^FDF.V^FS'))
check('etiqueta CANT:', z1.includes('^FDCANT:^FS'))
check('fecha producción dd/mm/yyyy', z1.includes('^FD23/07/2026^FS'))
check('fecha vencimiento dd/mm/yyyy', z1.includes('^FD22/07/2027^FS'))
check('cantidad presente', z1.includes('^FD193320^FS'))
check('unidad presente', z1.includes('^FDUN^FS'))
check('lote presente', z1.includes('^FD0869051017^FS'))
check('descripción envuelta (^FB 3 líneas)', z1.includes('^FB752,3,10,C'))
check("descripción completa con Ñ", z1.includes('DISEÑO 202'))

console.log('\n── 3. Copias y múltiples rótulos ──')
check('2 copias (^PQ2)', z1.includes('^PQ2,0,0,N'))
const z1c = construirZPLRotulo(DATOS, ENCABEZADO) // default 1 copia
check('1 copia por defecto', z1c.includes('^PQ1,0,0,N'))
const DATOS2 = { ...DATOS, codigo: '11688', descripcion: 'ALCOHOL RECTIFICADO AL 75 POR CIENTO', cantidad: '172800', unidad: 'KG' }
const zMulti = construirZPLRotulos([DATOS, DATOS2], [1, 3], ENCABEZADO)
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

console.log('\n── 5. Tildes/ñ con ^CI28 ──')
const zAcc = construirZPLRotulo(
  { ...DATOS, descripcion: 'PURÉ DE DURAZNO ÑANDÚ 30-32 ºBRIX' },
  ENCABEZADO
)
check('é conservada', zAcc.includes('PURÉ'))
check('Ñ conservada', zAcc.includes('ÑANDÚ'))
check('º conservado', zAcc.includes('ºBRIX'))

console.log('\n── 6. Campos vacíos (celdas en blanco, como la plantilla) ──')
const zVacio = construirZPLRotulo(
  { codigo: '5653', descripcion: 'PURE DE DURAZNO 30-32 ºBRIX', cantidad: '', unidad: 'KG', lote: '', fechaProduccion: '', fechaVencimiento: '' },
  ENCABEZADO
)
check('sin crash y estructura válida', zVacio.startsWith('^XA') && zVacio.trimEnd().endsWith('^XZ'))
check('lote vacío → sin texto en caja', !zVacio.includes('—'))
check('fechas vacías → ^FD^FS', zVacio.includes('^FD^FS'))
check('cantidad vacía → caja sin texto, unidad sí impresa', zVacio.includes('^FDKG^FS'))
check('etiquetas LOTE:/F.P/F.V/CANT: siempre presentes', ['LOTE:', 'F.P', 'F.V', 'CANT:'].every((t) => zVacio.includes(t)))

console.log(`\n═══ RESULTADO: ${passed} pasados, ${failed} fallados ═══`)
process.exit(failed > 0 ? 1 : 0)
