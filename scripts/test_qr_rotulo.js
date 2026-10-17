/**
 * RACKLY — Tests del formato QR del rótulo (qr-rotulo.ts) y su ZPL (zebra.ts).
 * Ejecutar:
 *   npx esbuild scripts/test_qr_rotulo.js --bundle --platform=node \
 *     --outfile=scripts/.testbuild/test_qr_rotulo.cjs --alias:@=./src --loader:.ts=ts \
 *   && node scripts/.testbuild/test_qr_rotulo.cjs
 */
const assert = require('assert')
const {
  PREFIJO_QR,
  construirPayloadQR,
  parsearPayloadQR,
} = require('@/lib/rackly/qr-rotulo')
const {
  payloadQRRotulo,
  construirZPLRotulo,
  construirZPLRotulos,
  sanearZPL,
} = require('@/lib/rackly/zebra')

let ok = 0
function t(nombre, fn) {
  try {
    fn()
    ok++
    console.log(`  ✓ ${nombre}`)
  } catch (e) {
    console.error(`  ✗ ${nombre}: ${e.message}`)
    process.exitCode = 1
  }
}

const GUIA = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const DATOS = {
  codigo: '49310',
  descripcion: 'LAMINA TERMOCONTRABLE 380 MM X 50 µ',
  cantidad: '193320',
  unidad: 'UN',
  lote: '0869051017',
  fechaProduccion: '2026-07-23',
  fechaVencimiento: '2027-07-22',
}
const ENC = {
  fecha: '2026-10-17',
  numeroDocumento: 'T173-00004090',
  proveedor: 'AJER S.A.',
  placa: 'C9G7B1',
  guiaId: GUIA,
}

console.log('— qr-rotulo (formato compartido) —')

t('construir: RKLY|guia|doc|codigo sin paleta', () => {
  const p = construirPayloadQR({ guiaId: GUIA, numeroDocumento: 'T173-1', codigo: '49310' })
  assert.strictEqual(p, `${PREFIJO_QR}|${GUIA}|T173-1|49310`)
})

t('construir: con paleta P2', () => {
  const p = construirPayloadQR({ guiaId: GUIA, numeroDocumento: 'T173-1', codigo: '49310', paleta: 2 })
  assert.strictEqual(p, `${PREFIJO_QR}|${GUIA}|T173-1|49310|P2`)
})

t('construir: paleta 0/negativa/NaN se ignora', () => {
  for (const paleta of [0, -1, NaN, null]) {
    const p = construirPayloadQR({ guiaId: 'g', numeroDocumento: 'd', codigo: 'c', paleta })
    assert.ok(!/\|P/.test(p), `paleta ${paleta} no debía salir: ${p}`)
  }
})

t('construir: '|' en los datos no rompe el formato', () => {
  const p = construirPayloadQR({ guiaId: 'g|1', numeroDocumento: 'd|2', codigo: 'c|3' })
  assert.strictEqual(p, 'RKLY|g 1|d 2|c 3')
  const q = parsearPayloadQR(p)
  assert.strictEqual(q.numeroDocumento, 'd 2')
})

t('parsear: payload completo con paleta', () => {
  const q = parsearPayloadQR(`  ${PREFIJO_QR}|${GUIA}|T173-1|49310|P3\r\n`)
  assert.deepStrictEqual(q, { guiaId: GUIA, numeroDocumento: 'T173-1', codigo: '49310', paleta: 3 })
})

t('parsear: sin paleta → null (no 0)', () => {
  const q = parsearPayloadQR(`${PREFIJO_QR}|${GUIA}|T173-1|49310`)
  assert.strictEqual(q.paleta, null)
})

t('parsear: prefijo case-insensitive, caso original conservado', () => {
  const q = parsearPayloadQR('rkly|G-UUID|x|AbC')
  assert.strictEqual(q.guiaId, 'G-UUID')
  assert.strictEqual(q.codigo, 'AbC')
})

t('parsear: guiaId vacío + numeroDocumento presente → válido (guías residuales)', () => {
  const q = parsearPayloadQR(`${PREFIJO_QR}||T173-1|49310`)
  assert.strictEqual(q.guiaId, '')
  assert.strictEqual(q.numeroDocumento, 'T173-1')
})

t('parsear: rechaza QRs ajenos (URL, texto suelto, vacío)', () => {
  assert.strictEqual(parsearPayloadQR('https://rackly.pages.dev/x'), null)
  assert.strictEqual(parsearPayloadQR('RKLY solo texto'), null)
  assert.strictEqual(parsearPayloadQR(''), null)
  assert.strictEqual(parsearPayloadQR(null), null)
  assert.strictEqual(parsearPayloadQR('RKLY|||'), null) // sin identidad
})

console.log('— zebra (QR en el ZPL) —')

t('payloadQRRotulo: extrae nº de paleta de "Paleta i/N"', () => {
  const p = payloadQRRotulo({ ...DATOS, paleta: 'Paleta 2/4' }, { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento })
  assert.strictEqual(p, `${PREFIJO_QR}|${GUIA}|${ENC.numeroDocumento}|49310|P2`)
})

t('payloadQRRotulo: sin identidad → null (rótulo sin QR)', () => {
  assert.strictEqual(payloadQRRotulo(DATOS, { guiaId: null, numeroDocumento: '' }), null)
  assert.strictEqual(payloadQRRotulo(DATOS, {}), null)
})

t('payloadQRRotulo: sanearZPL limpia ^ ~ \\ del código', () => {
  const p = payloadQRRotulo({ ...DATOS, codigo: 'AB^CD~E\\F' }, { guiaId: GUIA, numeroDocumento: 'd' })
  assert.ok(!/[\^~\\]/.test(p), `payload con caracteres ZPL peligrosos: ${p}`)
})

t('ZPL con guía: ^BQ nativo + payload QA + separador + código a 215', () => {
  const zpl = construirZPLRotulo(DATOS, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  assert.ok(zpl.includes('^BQN,2,'), 'falta ^BQ')
  const payload = `${PREFIJO_QR}|${GUIA}|${ENC.numeroDocumento}|49310`
  assert.ok(zpl.includes(`^FDQA,${payload}^FS`), 'falta ^FDQA,<payload>')
  assert.ok(zpl.includes('^A0R,267,'), `código debía salir a 267 dots: ${zpl.match(/\^A0R,\d+/)?.[0]}`)
  // El código se centra a la IZQUIERDA del separador: su ^FB es 852 (no 1152)
  assert.ok(zpl.includes('^FB852,'), `falta ^FB852 del área de texto con QR: ${zpl.match(/\^FB\d+/)?.[0]}`)
  // El QR va en la ESQUINA DERECHA (foto del usuario "AQUÍ VA QR"):
  // su ^FO físico tiene Y ≥ 900 (zona 900..1200 visual)
  const foQr = /\^FO(\d+),(\d+)\^BQN/.exec(zpl)
  assert.ok(foQr && Number(foQr[2]) >= 900, `QR debía anclarse en la zona derecha (Y fís ≥ 900): ${foQr?.[0]}`)
  // Línea límite en X visual 900 (borde izquierdo de la zona QR)
  assert.ok(zpl.includes('^FO560,900^GB240,3,2'), 'falta la línea límite en X visual 900')
  // Se mantiene el resto del formato: cantidad, lote, fechas, PQ
  assert.ok(zpl.includes('LOTE:'), 'falta LOTE')
  assert.ok(zpl.includes('CANT:'), 'falta CANT')
  assert.ok(zpl.includes('^PQ1,0,0,N'), 'falta ^PQ')
})

t('QR calibrado: payload con uuid (52+ chars) → mag 5 (tabla ISO exacta + quiet 4)', () => {
  const zpl = construirZPLRotulo({ ...DATOS, codigo: '126' }, { ...ENC, numeroDocumento: 'T173-1' }, { qr: { guiaId: GUIA, numeroDocumento: 'T173-1' } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  // RKLY|uuid|T173-1|126 = 52 bytes → v5 (37 módulos) → mag ⌊234/45⌋ = 5
  assert.strictEqual(mag, 5, `magnificación para payload 52: ${mag}`)
})

t('QR rótulo real (61 bytes: uuid + doc 13 + código 5): mag 5, lado 185', () => {
  const zpl = construirZPLRotulo(DATOS, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  assert.strictEqual(mag, 5, `mag para payload 61 (v5): ${mag}`)
  const fo = /\^FO(\d+),(\d+)\^BQN/.exec(zpl)
  // margenY (240−185)/2 = 27 → xFis = 800−27−185 = 588; margenX 57 → yFis 957
  assert.ok(fo && fo[1] === '588' && fo[2] === '957', `posición QR v5: ${fo?.[0]}`)
})

t('QR frontera conservadora: 62 bytes (código 3 + paleta) asume v6 → mag 4', () => {
  // La ISO declara v5-Q = 62 pero el encoder real manda 62 → v6 (verificado
  // en render): la tabla debe asumir MÁS módulos que el encoder para que el
  // símbolo real jamás desborde la quiet zone.
  const zpl = construirZPLRotulo({ ...DATOS, codigo: '126', paleta: 'Paleta 2/4' }, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  assert.strictEqual(mag, 4, `mag para payload 62 (asume v6): ${mag}`)
})

t('QR paleta 5 dígitos (64 bytes → v6): mag 4 (quiet 8 módulos, sin cambio)', () => {
  const zpl = construirZPLRotulo({ ...DATOS, paleta: 'Paleta 2/3' }, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  assert.strictEqual(mag, 4, `mag para payload 64 (v6): ${mag}`)
})

t('ZPL con guía corta SIN uuid (solo Nº doc) y código de 3 dígitos: QR mag ≥ 5', () => {
  const zpl = construirZPLRotulo({ ...DATOS, codigo: '126' }, { ...ENC, guiaId: null, numeroDocumento: 'T173-1' }, { qr: { guiaId: '', numeroDocumento: 'T173-1' } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  assert.ok(mag >= 5, `magnificación baja para payload corto: ${mag}`)
  // y sigue anclado en la zona derecha
  const foQr = /\^FO(\d+),(\d+)\^BQN/.exec(zpl)
  assert.ok(foQr && Number(foQr[2]) >= 900, `QR debía anclarse a la derecha: ${foQr?.[0]}`)
})

t('ZPL sin identidad (sin guiaId y sin Nº): SIN ^BQ y código a ancho completo', () => {
  const zpl = construirZPLRotulo(DATOS, { ...ENC, guiaId: null, numeroDocumento: '' }, {})
  assert.ok(!zpl.includes('^BQ'), 'no debía llevar QR')
  // Calibración Task 8 (tinta centrada, 2026-10-17): SIN QR el ancho es 1152 →
  // el alto del código llega al TOPE 286 (min(286, ⌊(1152−24)/(0.62×5)⌋)=286).
  assert.ok(zpl.includes('^A0R,286,'), 'código igualmente agrandado (alto 286 en ancho completo)')
  assert.ok(zpl.includes('^FB1152,'), 'código debía usar el ancho completo')
})

t('ZPL sin guiaId PERO con Nº de documento: SÍ lleva QR (guías residuales)', () => {
  const zpl = construirZPLRotulo(DATOS, { ...ENC, guiaId: null }, {})
  assert.ok(zpl.includes(`^FDQA,${PREFIJO_QR}||${ENC.numeroDocumento}|49310^FS`), 'QR de fallback por Nº')
})

t('construirZPLRotulos: copias 0 se omiten, el resto lleva QR', () => {
  const zpl = construirZPLRotulos(
    [DATOS, { ...DATOS, codigo: '126' }],
    [0, 1],
    ENC,
    { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento }
  )
  assert.strictEqual((zpl.match(/\^XA/g) || []).length, 1, 'solo 1 etiqueta')
  assert.strictEqual((zpl.match(/\^BQN/g) || []).length, 1, '1 QR')
})

t('sanearZPL: control y separadores fuera (→ espacio)', () => {
  assert.strictEqual(sanearZPL('A^B~C\\D\x01E '), 'A B C D E')
})

console.log(`\n${ok} tests OK`)
