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

console.log('\n── 1. Estructura ZPL (tira 10×15 cm, diseño apaisado 15×10) ──')
const z1 = construirZPLRotulo(DATOS, ENCABEZADO, { copias: 2 })
check('empieza con ^XA', z1.startsWith('^XA'))
check('termina con ^XZ', z1.trimEnd().endsWith('^XZ'))
check('UTF-8 (^CI28)', z1.includes('^CI28'))
check('ancho físico 800 dots (tira 10 cm)', z1.includes('^PW800'))
check('largo físico 1200 dots (tira 15 cm)', z1.includes('^LL1200'))
check('marco exterior 800×1200 desde (0,0)', z1.includes('^FO0,0^GB800,1200,3'))
check('SIN ^LH (desplazaba el marco fuera del área: bordes derecho/inferior no salían)', !z1.includes('^LH'))
check('texto ROTADO 90° horario (todo ^A0R, sin ^A0N)', !z1.includes('^A0N') && z1.includes('^A0R'))
check('código gigante rotado, agrandado (alto 267, glifo 160)', z1.includes('^A0R,267,160'))
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
check('descripción 63 chars → 1 renglón a fuente 48 (^FB1152,1,10,C)', z1.includes('^FB1152,1,10,C'))
const zDescLarga = construirZPLRotulo({ ...DATOS, descripcion: DATOS.descripcion + ' EXTRA LARGA' }, ENCABEZADO)
check('descripción 75 chars → 2 renglones (^FB1152,2,10,C)', zDescLarga.includes('^FB1152,2,10,C'))
check("descripción completa con Ñ", z1.includes('DISEÑO 202'))

console.log('\n── 2b. Bandas y cajas del diseño apaisado (coordenadas físicas) ──')
check('banda código (visual Y 0..240)', z1.includes('^FO560,0^GB240,1200,3'))
check('banda descripción (visual Y 240..400)', z1.includes('^FO400,0^GB160,1200,3'))
check('caja LOTE: (visual X 0..250)', z1.includes('^FO255,0^GB145,250,3'))
check('caja valor lote (visual X 250..1200)', z1.includes('^FO255,250^GB145,950,3'))
check('caja fecha F.P (fila superior)', z1.includes('^FO132,170^GB123,250,2'))
check('caja fecha F.V (fila inferior)', z1.includes('^FO8,170^GB124,250,2'))
check('caja cantidad (alta, X 540..1060)', z1.includes('^FO8,540^GB247,520,2'))
check('caja UM (X 1060..1200)', z1.includes('^FO8,1060^GB247,140,2'))

console.log('\n── 3. Copias y múltiples rótulos ──')
check('2 copias (^PQ2)', z1.includes('^PQ2,0,0,N'))
const z1c = construirZPLRotulo(DATOS, ENCABEZADO) // default 1 copia
check('1 copia por defecto', z1c.includes('^PQ1,0,0,N'))
const DATOS2 = { ...DATOS, codigo: '11688', descripcion: 'ALCOHOL RECTIFICADO AL 75 POR CIENTO', cantidad: '172800', unidad: 'KG' }
const zMulti = construirZPLRotulos([DATOS, DATOS2], [1, 3], ENCABEZADO)
check('2 etiquetas (2 ^XA)', (zMulti.match(/\^XA/g) || []).length === 2)
check('copias por rótulo (1 y 3)', zMulti.includes('^PQ1,0,0,N') && zMulti.includes('^PQ3,0,0,N'))

// ── Reimpresión parcial: copias 0 = ese rótulo NO sale (pedido 2026-10) ──
console.log('\n── 3b. Copias 0 = reimpresión parcial (omite el rótulo) ──')
const zParcial = construirZPLRotulos([DATOS, DATOS2], [1, 0], ENCABEZADO)
check('el rótulo con 0 se omite (1 ^XA)', (zParcial.match(/\^XA/g) || []).length === 1)
check('solo sale el que tiene copias > 0', zParcial.includes('56119') && !zParcial.includes('11688'))
check('nunca se genera ^PQ0', !/\^PQ0,/.test(zParcial))
const zSoloAlgunos = construirZPLRotulos([DATOS, DATOS2, { ...DATOS, codigo: '77001' }], [0, 2, 0], ENCABEZADO)
check('solo el del medio sale (con sus 2 copias)', (zSoloAlgunos.match(/\^XA/g) || []).length === 1 && zSoloAlgunos.includes('^PQ2,0,0,N') && zSoloAlgunos.includes('11688') && !zSoloAlgunos.includes('56119') && !zSoloAlgunos.includes('77001'))
check('todos en 0 → ZPL vacío (sin ^XA)', construirZPLRotulos([DATOS, DATOS2], [0, 0], ENCABEZADO) === '')
check('copias faltante en el array → 1 por defecto (compat)', (construirZPLRotulos([DATOS], [], ENCABEZADO).match(/\^XA/g) || []).length === 1)
check('singular: clamp 1..999 intacto (0 → 1 para llamadas directas)', construirZPLRotulo(DATOS, ENCABEZADO, { copias: 0 }).includes('^PQ1,0,0,N'))

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

console.log('\n── 7. Auto-ajuste y centrado del código gigante (apaisado) ──')
const zCorto = construirZPLRotulo({ ...DATOS, codigo: '56119' }, ENCABEZADO)
const zLargo = construirZPLRotulo({ ...DATOS, codigo: '1234567' }, ENCABEZADO)
const zLargo12 = construirZPLRotulo({ ...DATOS, codigo: '123456789012' }, ENCABEZADO)
function codigoFisico(z) {
  const m = z.match(/\^FO(\d+),(\d+)\^A0R,(\d+),/)
  return m ? { xFis: Number(m[1]), yFis: Number(m[2]), alto: Number(m[3]) } : null
}
const aCorto = codigoFisico(zCorto)
const aLargo = codigoFisico(zLargo)
const aLargo12 = codigoFisico(zLargo12)
check('código 5 dígitos usa el alto máximo nuevo (267)', aCorto && aCorto.alto === 267)
check('código 7 dígitos cabe en el ancho con QR (7 × 0.6 × 190 = 798 < 828)', aLargo && aLargo.alto === 190 && 7 * 0.6 * 190 < 828)
check('código 12 dígitos se reduce (alto 111 < 267) y cabe (799 < 828)', aLargo12 && aLargo12.alto === 111 && 12 * 0.6 * 111 < 828)
check(
  'tinta del código CENTRADA en la banda y sin tocar líneas (calibrado)',
  aCorto && (() => {
    const y0 = 800 - aCorto.xFis - aCorto.alto
    const sup = y0 - 0.0102 * aCorto.alto
    const inf = y0 + 0.7611 * aCorto.alto
    return sup >= 6 && inf <= 234 && Math.abs((sup + inf) / 2 - 120) <= 3
  })()
)

console.log('\n── 8. Límites físicos: nada sale del área 800×1200 ──')
function limitesOK(z) {
  const fos = [...z.matchAll(/\^FO(\d+),(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])])
  const gbs = [...z.matchAll(/\^GB(\d+),(\d+),/g)].map((m) => [Number(m[1]), Number(m[2])])
  return (
    fos.every(([x, y]) => x >= 0 && x <= 800 && y >= 0 && y <= 1200) &&
    gbs.every(([w, h]) => w > 0 && w <= 800 && h > 0 && h <= 1200) &&
    fos.length > 0 && gbs.length > 0
  )
}
check('todos los ^FO y ^GB dentro de la tira (rótulo completo)', limitesOK(z1))
check('límites respetados con campos vacíos', limitesOK(zVacio))
check('límites respetados con código de 12 dígitos', limitesOK(zLargo12))

console.log('\n── 9. Marca de PALETA (artículo dividido: "Paleta i/N") ──')
const zSinPaleta = construirZPLRotulo({ ...DATOS }, ENCABEZADO)
const zConPaleta = construirZPLRotulo({ ...DATOS, paleta: 'Paleta 2/3' }, ENCABEZADO)
check('sin paleta: la banda LOTE llega hasta 1200 (ancho completo) y NO hay caja de paleta', zSinPaleta.includes('^GB145,700,3') === false && zSinPaleta.includes('^GB145,250,2') === false)
check('con paleta: el valor del lote se acorta (caja hasta 950)', zConPaleta.includes('^GB145,700,3'))
check('con paleta: existe la caja de la marca (250 de ancho en el extremo derecho)', zConPaleta.includes('^GB145,250,2'))
check('con paleta: el texto "Paleta 2/3" va impreso', zConPaleta.includes('^FDPaleta 2/3^FS') || /Paleta 2\/3\^FS/.test(zConPaleta), zConPaleta.match(/Paleta[^^]*\^FS/)?.[0])
check('sin paleta: el texto de paleta NO aparece', !/Paleta \d\/\d\^FS/.test(zSinPaleta))
check('límites físicos respetados con paleta', limitesOK(zConPaleta))
const zPaletaLoteLargo = construirZPLRotulo({ ...DATOS, lote: 'LOTE-DE-40-CARACTERES-XXXXXXX', paleta: 'Paleta 1/5' }, ENCABEZADO)
check('lote largo + paleta: el lote se auto-ajusta a su caja acortada', limitesOK(zPaletaLoteLargo) && /LOTE-DE-40/.test(zPaletaLoteLargo))
check('sanearZPL también limpia la marca de paleta', construirZPLRotulo({ ...DATOS, paleta: 'Pa^leta 1/2' }, ENCABEZADO).includes('Pa leta 1/2'))

console.log(`\n═══ RESULTADO: ${passed} pasados, ${failed} fallados ═══`)
process.exit(failed > 0 ? 1 : 0)
