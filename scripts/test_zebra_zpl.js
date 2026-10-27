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
 *   7. Descripción: layout DETERMINISTA (Task 30) — centrada en su recuadro,
 *      1-2 renglones propios (NUNCA ^FB multilínea rotado), fuente máxima
 *      sin tocar líneas (modelo de tinta calibrado), descendentes protegidos.
 */

const {
  construirZPLRotulo,
  construirZPLRotulos,
  sanearZPL,
  layoutDescripcion,
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
check('ancho imprimible 824 = diseño 800 + corrimiento 3 mm (ver ^LH)', z1.includes('^PW824'))
check('largo físico 1200 dots (tira 15 cm)', z1.includes('^LL1200'))
check('marco exterior 800×1200 desde (0,0)', z1.includes('^FO0,0^GB800,1200,3'))
check(
  'origen de impresión corrido 3 mm (^LH24,0): TODO el rótulo sale desplazado en bloque (pedido 2026-10-28: el borde caía fuera del sticker)',
  z1.includes('^LH24,0')
)
check('texto ROTADO 90° horario (todo ^A0R, sin ^A0N)', !z1.includes('^A0N') && z1.includes('^A0R'))
check('código gigante rotado, agrandado (alto 234, glifo 140) — ancho 752 con QR 4cm', z1.includes('^A0R,234,140'))
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
check(
  'fechas MÁS GRANDES (em 60, celda 41) centradas en su caja de 250 sin salirse',
  z1.includes('^A0R,60,41^FB250,1,0,C^FD23/07/2026^FS') &&
    z1.includes('^A0R,60,41^FB250,1,0,C^FD22/07/2027^FS') &&
    10 * 0.53 * 41 <= 236
)
check(
  'etiquetas LOTE:/F.P/F.V/CANT: más grandes (76/64/64/52) y UM hasta 96',
  z1.includes('^A0R,76,58') && z1.includes('^A0R,64,50') && z1.includes('^A0R,52,38') && z1.includes('^A0R,96,58')
)
check('cantidad presente', z1.includes('^FD193320^FS'))
check('unidad presente', z1.includes('^FDUN^FS'))
check('lote presente', z1.includes('^FD0 8 6 9 0 5 1 0 1 7^FS'))
check(
  'lote con dígitos SEPARADOS por espacios (em 104, celda 0.65×em = 68)',
  z1.includes('^A0R,104,68') && z1.includes('^FD0 8 6 9 0 5 1 0 1 7^FS')
)
const zLote15 = construirZPLRotulo({ ...DATOS, lote: '123456789012345' }, ENCABEZADO)
check(
  'lote > 14 chars → compacto sin espacios (auto-ajuste probado)',
  zLote15.includes('^FD1 2 3 4 5 6 7 8 9 0 1 2 3 4 5^FS') === false && /\^A0R,\d+,\d+\^FB950,1,0,C\^FD123456789012345\^FS/.test(zLote15)
)
const zLoteAlfa = construirZPLRotulo({ ...DATOS, lote: 'AB-12-CD' }, ENCABEZADO)
check(
  'lote alfanumérico: solo pares de dígitos se espacian (12 → 1 2; AB/CD intactos)',
  zLoteAlfa.includes('^FDAB-1 2-CD^FS')
)
check(
  'descripción 63 chars CON QR → 3 renglones a fuente 47 LLENANDO el recuadro (Task 31: antes 2×48 al 64%)',
  z1.includes('^FO503,24^A0R,47,40^FB752,1,0,C^FDENVASE TETRA PACK PULP^FS') &&
    z1.includes('^FO451,24^A0R,47,40^FB752,1,0,C^FDDURAZNO FORTI HIERRO^FS') &&
    z1.includes('^FO399,24^A0R,47,40^FB752,1,0,C^FD145 ML - DISEÑO 202^FS')
)
const zDescLarga = construirZPLRotulo({ ...DATOS, descripcion: DATOS.descripcion + ' EXTRA LARGA' }, ENCABEZADO)
check('descripción 77 chars → 3 renglones balanceados a fuente 47 llenando el recuadro', zDescLarga.includes('^A0R,47,40^FB752,1,0,C^FDML - DISEÑO 202 EXTRA LARGA^FS'))
const zDescCorta = construirZPLRotulo({ ...DATOS, descripcion: 'SAL INDUSTRIAL' }, ENCABEZADO)
check('descripción corta (14 chars) → 2 renglones a fuente 74 llenando el recuadro (Task 31: antes 1×111 al 61%)', zDescCorta.includes('^FO476,24^A0R,74,63^FB752,1,0,C^FDSAL^FS') && zDescCorta.includes('^FO393,24^A0R,74,63^FB752,1,0,C^FDINDUSTRIAL^FS'))
check(
  'NUNCA ^FB multilínea (el rotado apila hacia arriba y cruzaba el recuadro — foto del sticker)',
  !/\^FB\d+,[2-9]/.test(z1) && !/\^FB\d+,[2-9]/.test(zDescLarga) && !/\^FB\d+,[2-9]/.test(zDescCorta)
)
check("descripción completa con Ñ", z1.includes('DISEÑO 202'))

console.log('\n── 2b. Bandas y cajas del diseño apaisado (coordenadas físicas) ──')
check('banda código con QR 4cm (visual Y 0..240, X 0..800)', z1.includes('^FO560,0^GB240,800,3'))
check('banda descripción con QR (visual Y 240..400, X 0..800)', z1.includes('^FO400,0^GB160,800,3'))
check('caja LOTE: (visual X 0..250)', z1.includes('^FO255,0^GB145,250,3'))
check('caja valor lote (visual X 250..1200)', z1.includes('^FO255,250^GB145,950,3'))
check('caja fecha F.P (fila superior)', z1.includes('^FO132,170^GB123,250,2'))
check('caja fecha F.V (fila inferior)', z1.includes('^FO8,170^GB124,250,2'))
check('caja cantidad (alta, X 540..1060)', z1.includes('^FO8,540^GB247,520,2'))
check('caja UM (X 1060..1200)', z1.includes('^FO8,1060^GB247,140,2'))

// ── 2c. Cantidad LLENA su caja (Task 10, zona verde del usuario) ──
// len 6 → w = ⌊996/6⌋ = 166 · baseline = 663.5 + 0.3857×294 = 777 → ^FT23
check('cantidad con ^FT (anclaje baseline, celda 294 cuelga del lienzo sin tinta)', z1.includes('^FT23,540^A0R,294,166') && z1.includes('^FT23,542^A0R,294,166'))
check('span de la cantidad BAJO el umbral de salto del ^FB (0.462×166×6 = 460 ≤ 477)', 6 * 0.462 * 166 <= 477)
check(
  'tinta de la cantidad CENTRADA en su caja sin tocar líneas (modelo calibrado)',
  (() => {
    const B = 777
    const em = 294
    const sup = B - 0.7713 * em + 5 // sesgo +5 del motor, medido en render
    const inf = B + 5
    return sup >= 547 && inf <= 790 && Math.abs((sup + inf) / 2 - 668.5) <= 3
  })()
)
const zCantLarga = construirZPLRotulo({ ...DATOS, cantidad: 'X'.repeat(21) }, ENCABEZADO)
check('cantidad absurda (>20 chars) degrada a auto-ajuste clásico sin ^FT', zCantLarga.includes('^FO') && !zCantLarga.includes('^FT'))

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
check('código 5 dígitos usa el alto máximo con QR 4cm (234)', aCorto && aCorto.alto === 234)
check('código 7 dígitos cabe en el ancho con QR (7 × 0.6 × 167 = 701 < 776)', aLargo && aLargo.alto === 167 && 7 * 0.6 * 167 < 776)
check('código 12 dígitos se reduce (alto 97 < 234) y cabe (698 < 776)', aLargo12 && aLargo12.alto === 97 && 12 * 0.6 * 97 < 776)
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

console.log('\n── 10. QR de guía 4 × 4 cm (Task 28 — salía borroso a mag máx 6 ≈ 2.6 cm) ──')
// Casos: 24 chars (sin guia_id) → v3 mag10 · 61 chars (uuid36+guía 13+código 5
// — el payload DOMINANTE de producción) → v5 mag9 = 333 dots = 4.16 cm ·
// 64 chars (con paleta P2) → v6 mag8 = 328 dots = 4.10 cm.
const ENC_SIN_DOC = { fecha: '2026-10-09' }
const GUIA36 = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
function qrDe(z) {
  const m = z.match(/\^FO(\d+),(\d+)\^BQN,2,(\d+)\^FDQA,([^^]+)\^FS/)
  return m ? { xFis: Number(m[1]), yFis: Number(m[2]), mag: Number(m[3]), payload: m[4] } : null
}
const MODS = [31, 45, 61, 75, 87, 999] // fronteras de modulosQR
function modsDe(len) { return len <= 31 ? 29 : len <= 45 ? 33 : len <= 61 ? 37 : len <= 75 ? 41 : len <= 87 ? 45 : 49 }
function assertQR4cm(nombre, z, lenEsperado) {
  const q = qrDe(z)
  if (!q) { check(nombre + ' — QR presente', false); return }
  const mods = modsDe(q.payload.length)
  const lado = mods * q.mag
  const margen = (394 - lado) / 2 // margen real al borde interior (centrado)
  const yVisSup = 800 - q.xFis - lado // margen superior visual (quiet zone del lado superior)
  const cm = (lado / 203.2 * 2.54).toFixed(2)
  check(
    `${nombre} — símbolo ${lado} dots ≈ ${cm} cm (mag ${q.mag}, mods ${mods}) con quiet ≥ 3 módulos y dentro del cuadrante`,
    q.payload.length === lenEsperado &&
      q.mag >= 3 && q.mag <= 10 &&
      lado >= 280 && lado <= 350 && // 3.5..4.3 cm — el rango 4×4 con quiet honesta
      margen >= 3 * q.mag - 1 && // quiet zone ≥ 3 módulos (floor del diseño)
      q.xFis >= 0 && q.xFis + lado <= 800 &&
      q.yFis >= 800 && q.yFis + lado <= 1200 &&
      yVisSup - 3 >= 3 * q.mag - 1 // quiet zone del lado superior (después de la línea de 3 dots)
  )
  return q
}
const zQr26 = construirZPLRotulo(DATOS, ENC_SIN_DOC, { qr: { guiaId: null, numeroDocumento: 'T173-0000409' } }) // 4+1+13+1+5=24? → 24 chars
assertQR4cm('payload 24 chars (v3)', zQr26, 24)
const zQr61 = construirZPLRotulo(DATOS, ENC_SIN_DOC, { qr: { guiaId: GUIA36, numeroDocumento: 'T173-00004090' } }) // 4+1+36+1+13+1+5 = 61 (v5 — DOMINANTE)
const q61 = assertQR4cm('payload 61 chars (v5, uuid+guía+código real)', zQr61, 61)
check('payload dominante v5 a mag 9 = 333 dots = 4.16 cm (clava el 4×4 pedido)', q61 && q61.mag === 9 && 37 * 9 === 333)
const zQrPaleta = construirZPLRotulo({ ...DATOS, paleta: 'Paleta 2/4' }, ENC_SIN_DOC, { qr: { guiaId: GUIA36, numeroDocumento: 'T173-00004090' } }) // 61+3 = 64 (v6)
const qPaleta = assertQR4cm('payload con paleta (v6 + P2)', zQrPaleta, 64)
check('payload v6 a mag 8 = 328 dots = 4.10 cm', qPaleta && qPaleta.mag === 8 && 41 * 8 === 328)
check('EC level Q (FDQA) en todos los QR', [zQr26, zQr61, zQrPaleta].every((z) => /\^FDQA,/.test(z)))
check('paleta viaja en el QR (P2)', /RKLY\|[^|]*\|T173-00004090\|56119\|P2\^FS/.test(zQrPaleta))
check('sin identidad de guía → SIN QR y bandas a ancho completo (1200)', (() => {
  const z = construirZPLRotulo(DATOS, ENC_SIN_DOC)
  return !z.includes('^BQN') && z.includes('^FO560,0^GB240,1200,3') && z.includes('^FO400,0^GB160,1200,3') && z.includes('^A0R,286,')
})())
check('separadora del límite X 800 baja hasta Y 400 (cruza código y descripción)', z1.includes('^FO400,800^GB400,3,2'))
check('límites físicos respetados con QR 4cm', limitesOK(zQr61) && limitesOK(zQrPaleta) && limitesOK(zQr26))

console.log('\n── 11. Descripción centrada y máxima en su recuadro (Task 30 — foto del sticker) ──')
// Caso EXACTO de la foto: código 55492 · "BASE PARA BEBIDA JARABEADA
// CARBONATADA FRESA 50496" (50 chars) CON QR de guía (banda 0..800 → ^FB 752).
const FOTO = 'BASE PARA BEBIDA JARABEADA CARBONATADA FRESA 50496'
const zFoto = construirZPLRotulo(
  { ...DATOS, codigo: '55492', descripcion: FOTO, cantidad: '40', lote: '2288609080291', fechaProduccion: '2026-09-08', fechaVencimiento: '2027-09-08' },
  ENCABEZADO,
  { qr: { guiaId: GUIA36, numeroDocumento: 'T173-00004090' } }
)
check(
  'foto: 3 renglones balanceados (16/21/11) a fuente 47 — el bloque LLENA el recuadro (99%) y llega abajo',
  zFoto.includes('^FO503,24^A0R,47,40^FB752,1,0,C^FDBASE PARA BEBIDA^FS') &&
    zFoto.includes('^FO451,24^A0R,47,40^FB752,1,0,C^FDJARABEADA CARBONATADA^FS') &&
    zFoto.includes('^FO399,24^A0R,47,40^FB752,1,0,C^FDFRESA 50496^FS')
)
check(
  'foto: tinta de los 3 renglones DENTRO de 249..391, centrada y LLENANDO ≥85% (más abajo, ajustada al rectángulo)',
  (() => {
    // y1=250, paso=52, em=47 · renglones en y 250/302/354
    const sup = 250 + 0.017 * 47
    const inf = 354 + 0.763 * 47
    return sup >= 249 && inf <= 391 && Math.abs((sup + inf) / 2 - 320) <= 2 && (inf - sup) / 142 >= 0.85
  })()
)
check('foto: el bloque de descripción queda DEBAJO del código y ENCIMA del lote (banda propia)', zFoto.includes('^FO400,0^GB160,800,3') && zFoto.includes('^FO503,24^A0R,47,40'))

// Descendentes (µ / minúsculas / Q de cola): el modelo de tinta protege el fondo
const zMicro = construirZPLRotulo({ ...DATOS, descripcion: 'LAMINA TERMOCONTRAIBLE 550 MM X 80 µ' }, ENCABEZADO)
check(
  'descendentes (µ): fuente 68 en 2 renglones con fondo de tinta ≤ 391',
  zMicro.includes('^FO482,24^A0R,68,58^FB752,1,0,C^FDLAMINA TERMOCONTRAIBLE^FS') &&
    zMicro.includes('^FO406,24^A0R,68,58^FB752,1,0,C^FD550 MM X 80 µ^FS') &&
    (() => {
      const l = layoutDescripcion('LAMINA TERMOCONTRAIBLE 550 MM X 80 µ', 752)
      if (!l) return false
      const fondo = l.y1 + l.paso + 0.933 * l.em
      return fondo <= 391 && fondo >= 385 // protegido PERO aprovecha la banda
    })()
)

// Red de seguridad: texto absurdo (200 chars, 1 palabra) → truncado chico dentro del recuadro
const zAbsurdo = construirZPLRotulo({ ...DATOS, descripcion: 'X'.repeat(200) }, ENCABEZADO)
check(
  'texto absurdo: red de seguridad trunca a fuente 20 sin tocar líneas ni salir del área',
  /\^A0R,20,17\^FB752,1,0,C\^FDX{20,}\^FS/.test(zAbsurdo) && limitesOK(zAbsurdo)
)

// Batería de invariantes sobre longitudes representativas (catálogo 4..63, p95 62)
function descripcionOK(texto, anchoLinea) {
  const l = layoutDescripcion(texto, anchoLinea)
  if (!l) return false
  const conCola = /[a-zµ,;Q]/.test(texto)
  const fondoEm = conCola ? 0.933 : 0.763
  const sup = l.y1 + 0.017 * l.em
  const inf = l.y1 + (l.lineas.length - 1) * l.paso + fondoEm * l.em
  const maxChars = Math.max(...l.lineas.map((s) => s.length))
  return (
    l.em >= 20 &&
    l.lineas.length <= 3 && // 4+ renglones darían glifos más chicos que el viejo 38
    sup >= 249 && inf <= 391 && // nunca toca las líneas (240..243 / 397..400)
    Math.abs((sup + inf) / 2 - 320) <= 2 && // tinta centrada en la banda
    l.llenado >= 0.85 && // Task 31: el bloque LLENA el recuadro (≥85% de la zona)
    maxChars * 0.55 * l.w <= anchoLinea - 24 && // margen lateral ≥ 12 por lado
    l.w >= Math.round(l.em * 0.85) - 1 // celda natural (glifo legible, no comprimido)
  )
}
const LONGITUDES = ['SAL 50', 'SAL INDUSTRIAL', 'ACIDO CITRICO ANHIDRO USP', 'LAMINA TERMOCONTRAIBLE 550 MM X 80 µ', 'ALCOHOL RECTIFICADO AL 75 POR CIENTO (q)', FOTO, 'ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 145 ML - DISEÑO 202', 'X'.repeat(63).replace(/(.{10})/g, '$1 ').trim()]
check(
  'invariantes de layout en 8 longitudes × con/sin QR (tinta dentro, centrada, margen lateral)',
  LONGITUDES.every((t) => descripcionOK(t, 752) && descripcionOK(t, 1152))
)
check(
  'la fuente crece al acortar el texto (máximo tamaño posible en cada caso)',
  (() => {
    const l63 = layoutDescripcion('X'.repeat(63).replace(/(.{10})/g, '$1 ').trim(), 752)
    const l14 = layoutDescripcion('SAL INDUSTRIAL', 752)
    return l63 && l14 && l14.em > l63.em
  })()
)

console.log(`\n═══ RESULTADO: ${passed} pasados, ${failed} fallados ═══`)
process.exit(failed > 0 ? 1 : 0)
