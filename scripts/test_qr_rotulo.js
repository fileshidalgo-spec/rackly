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
const {
  resolverToma,
} = require('@/lib/rackly/atencion-qr-lote')

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

t('construir: RKLY|identidad|doc|codigo sin paleta', () => {
  const p = construirPayloadQR({ identidad: GUIA, numeroDocumento: 'T173-1', codigo: '49310' })
  assert.strictEqual(p, `${PREFIJO_QR}|${GUIA}|T173-1|49310`)
})

t('construir: con paleta P2', () => {
  const p = construirPayloadQR({ identidad: GUIA, numeroDocumento: 'T173-1', codigo: '49310', paleta: 2 })
  assert.strictEqual(p, `${PREFIJO_QR}|${GUIA}|T173-1|49310|P2`)
})

t('construir: paleta 0/negativa/NaN se ignora', () => {
  for (const paleta of [0, -1, NaN, null]) {
    const p = construirPayloadQR({ identidad: 'g', numeroDocumento: 'd', codigo: 'c', paleta })
    assert.ok(!/\|P/.test(p), `paleta ${paleta} no debía salir: ${p}`)
  }
})

t('construir: '|' en los datos no rompe el formato', () => {
  const p = construirPayloadQR({ identidad: 'g|1', numeroDocumento: 'd|2', codigo: 'c|3' })
  assert.strictEqual(p, 'RKLY|g 1|d 2|c 3')
  const q = parsearPayloadQR(p)
  assert.strictEqual(q.numeroDocumento, 'd 2')
})

t('parsear: payload completo con paleta', () => {
  const q = parsearPayloadQR(`  ${PREFIJO_QR}|${GUIA}|T173-1|49310|P3\r\n`)
  assert.deepStrictEqual(q, { identidad: GUIA, numeroDocumento: 'T173-1', codigo: '49310', paleta: 3 })
})

t('parsear: sin paleta → null (no 0)', () => {
  const q = parsearPayloadQR(`${PREFIJO_QR}|${GUIA}|T173-1|49310`)
  assert.strictEqual(q.paleta, null)
})

t('parsear: prefijo case-insensitive, caso original conservado', () => {
  const q = parsearPayloadQR('rkly|G-UUID|x|AbC')
  assert.strictEqual(q.identidad, 'G-UUID')
  assert.strictEqual(q.codigo, 'AbC')
})

t('parsear: identidad vacía + numeroDocumento presente → válido (guías residuales)', () => {
  const q = parsearPayloadQR(`${PREFIJO_QR}||T173-1|49310`)
  assert.strictEqual(q.identidad, '')
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

t('ZPL con guía: ^BQ nativo + payload QA + separador + código a 234 (Task 28)', () => {
  const zpl = construirZPLRotulo(DATOS, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  assert.ok(zpl.includes('^BQN,2,'), 'falta ^BQ')
  const payload = `${PREFIJO_QR}|${GUIA}|${ENC.numeroDocumento}|49310`
  assert.ok(zpl.includes(`^FDQA,${payload}^FS`), 'falta ^FDQA,<payload>')
  assert.ok(zpl.includes('^A0R,234,'), `código debía salir a 234 dots: ${zpl.match(/\^A0R,\d+/)?.[0]}`)
  // El código se centra a la IZQUIERDA del separador: su ^FB es 752 (no 1152)
  assert.ok(zpl.includes('^FB752,'), `falta ^FB752 del área de texto con QR: ${zpl.match(/\^FB\d+/)?.[0]}`)
  // El QR va en la ESQUINA DERECHA (cuadrante 800..1200 visual, Task 28):
  // su ^FO físico tiene Y ≥ 800 (zona QR nueva)
  const foQr = /\^FO(\d+),(\d+)\^BQN/.exec(zpl)
  assert.ok(foQr && Number(foQr[2]) >= 800, `QR debía anclarse en la zona derecha (Y fís ≥ 800): ${foQr?.[0]}`)
  // Línea límite en X visual 800, desde Y 0 hasta Y 400 (borde de la zona QR 4×4)
  assert.ok(zpl.includes('^FO400,800^GB400,3,2'), 'falta la línea límite en X visual 800')
  // Se mantiene el resto del formato: cantidad, lote, fechas, PQ
  assert.ok(zpl.includes('LOTE:'), 'falta LOTE')
  assert.ok(zpl.includes('CANT:'), 'falta CANT')
  assert.ok(zpl.includes('^PQ1,0,0,N'), 'falta ^PQ')
})

t('QR 4×4 cm: payload con uuid (52+ chars) → mag 9 (dominante Task 28)', () => {
  const zpl = construirZPLRotulo({ ...DATOS, codigo: '126' }, { ...ENC, numeroDocumento: 'T173-1' }, { qr: { guiaId: GUIA, numeroDocumento: 'T173-1' } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  // RKLY|uuid|T173-1|126 = 52 bytes → v5 (37 módulos) → mag ⌊394/43⌋ = 9
  assert.strictEqual(mag, 9, `magnificación para payload 52: ${mag}`)
})

t('QR rótulo real (61 bytes: uuid + doc 13 + código 5): mag 9, lado 333 = 4.16 cm', () => {
  const zpl = construirZPLRotulo(DATOS, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  assert.strictEqual(mag, 9, `mag para payload 61 (v5): ${mag}`)
  const fo = /\^FO(\d+),(\d+)\^BQN/.exec(zpl)
  // margen (394−333)/2 = 30 → yVisSup 33 → xFis = 800−33−333 = 434; yFis = 800+3+30 = 833
  assert.ok(fo && fo[1] === '434' && fo[2] === '833', `posición QR v5: ${fo?.[0]}`)
})

t('QR frontera conservadora: 62 bytes (código 3 + paleta) asume v6 → mag 8 = 328 dots (4.10 cm)', () => {
  // La ISO declara v5-Q = 62 pero el encoder real manda 62 → v6 (verificado
  // en render): la tabla debe asumir MÁS módulos que el encoder para que el
  // símbolo real jamás desborde la quiet zone.
  const zpl = construirZPLRotulo({ ...DATOS, codigo: '126', paleta: 'Paleta 2/4' }, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  assert.strictEqual(mag, 8, `mag para payload 62 (asume v6): ${mag}`)
})

t('QR paleta 5 dígitos (64 bytes → v6): mag 8 = 328 dots (4.10 cm)', () => {
  const zpl = construirZPLRotulo({ ...DATOS, paleta: 'Paleta 2/3' }, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  assert.strictEqual(mag, 8, `mag para payload 64 (v6): ${mag}`)
})

t('ZPL con guía corta SIN uuid (solo Nº doc) y código de 3 dígitos: QR mag ≥ 5', () => {
  const zpl = construirZPLRotulo({ ...DATOS, codigo: '126' }, { ...ENC, guiaId: null, numeroDocumento: 'T173-1' }, { qr: { guiaId: '', numeroDocumento: 'T173-1' } })
  const mag = Number(/\^BQN,2,(\d+)/.exec(zpl)[1])
  assert.ok(mag >= 5, `magnificación baja para payload corto: ${mag}`)
  // y sigue anclado en la zona derecha (cuadrante 800..1200 visual)
  const foQr = /\^FO(\d+),(\d+)\^BQN/.exec(zpl)
  assert.ok(foQr && Number(foQr[2]) >= 800, `QR debía anclarse a la derecha: ${foQr?.[0]}`)
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

console.log('— QR ÚNICO POR RÓTULO (recepcionId) —')

const FILA = 'a1b2c3d4-e5f6-4789-8a9b-c0d1e2f3a4b5' // uuid de la fila del palet

t('payloadQRRotulo: recepcionId de la fila TIENE prioridad sobre guiaId', () => {
  const p = payloadQRRotulo(
    { ...DATOS, recepcionId: FILA },
    { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento }
  )
  assert.strictEqual(p, `${PREFIJO_QR}|${FILA}|${ENC.numeroDocumento}|49310`)
})

t('payloadQRRotulo: sin recepcionId → identidad de guía (rótulos legados)', () => {
  const p = payloadQRRotulo(DATOS, { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento })
  assert.strictEqual(p, `${PREFIJO_QR}|${GUIA}|${ENC.numeroDocumento}|49310`)
})

t('payloadQRRotulo: recepcionId + paleta → RKLY|fila|doc|codigo|Pn (mismo largo que legado)', () => {
  const p = payloadQRRotulo(
    { ...DATOS, recepcionId: FILA, paleta: 'Paleta 3/8' },
    { guiaId: null, numeroDocumento: ENC.numeroDocumento }
  )
  assert.strictEqual(p, `${PREFIJO_QR}|${FILA}|${ENC.numeroDocumento}|49310|P3`)
})

t('payloadQRRotulo: recepcionId vacío cae a guiaId; sin nada → null', () => {
  const p = payloadQRRotulo({ ...DATOS, recepcionId: '  ' }, { guiaId: GUIA, numeroDocumento: 'd' })
  assert.ok(p.startsWith(`${PREFIJO_QR}|${GUIA}|`))
  assert.strictEqual(payloadQRRotulo({ ...DATOS, recepcionId: '' }, { guiaId: null, numeroDocumento: '' }), null)
})

t('ZPL: rótulo con recepcionId lleva el QR de la fila y mismo tamaño (uuid↔uuid)', () => {
  const zplConFila = construirZPLRotulo({ ...DATOS, recepcionId: FILA }, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  assert.ok(zplConFila.includes(`^FDQA,${PREFIJO_QR}|${FILA}|${ENC.numeroDocumento}|49310^FS`), 'QR con la fila exacta')
  const zplLegado = construirZPLRotulo(DATOS, ENC, { qr: { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento } })
  const magFila = Number(/\^BQN,2,(\d+)/.exec(zplConFila)[1])
  const magLegado = Number(/\^BQN,2,(\d+)/.exec(zplLegado)[1])
  assert.strictEqual(magFila, magLegado, 'mismo largo de payload → misma magnificación')
})

console.log('— resolverToma: ruta EXACTA (fila del QR) —')

function filaDe(overrides) {
  return {
    id: FILA,
    guiaId: GUIA,
    createdAt: '2026-10-27T10:00:00Z',
    fecha: '2026-10-27',
    tipoDocumento: 'Guia',
    numeroDocumento: 'T173-00005000',
    empresaOrigen: 'AJEPER',
    proveedor: 'PROV',
    codigo: '43684',
    descripcion: 'ARTICULO PRUEBA',
    cantidad: 100,
    unidadMedida: 'KG',
    lote: 'LOTE-A',
    fechaProduccion: '',
    fechaVencimiento: '2027-01-01',
    placa: '',
    nPaleta: null,
    usuarioNombre: 'op',
    observaciones: '',
    envios: [],
    enviados: 0,
    pendiente: 100,
    estado: 'ROJO',
    datosFaltantes: [],
    ...overrides,
  }
}
const TOMA_ARGS = { texto: `${PREFIJO_QR}|${FILA}|T173-00005000|43684`, codigoRq: '43684', carrito: [], nuevoUuid: () => 'u1' }

t('ruta exacta: la toma sale de LA FILA del QR (no FEFO)', () => {
  const otra = filaDe({ id: '11111111-1111-4111-8111-111111111111', lote: 'LOTE-OTRO', cantidad: 55, pendiente: 55 })
  const res = resolverToma({ ...TOMA_ARGS, filaExacta: filaDe({}), filas: [otra] })
  assert.strictEqual(res.estado, 'ok')
  assert.strictEqual(res.toma.recepcionId, FILA)
  assert.strictEqual(res.toma.lote, 'LOTE-A')
  assert.strictEqual(res.toma.cantidad, 100)
})

t('ruta exacta: re-escanear el mismo rótulo → PALETA_YA_EN_CARRITO (no consume otra fila)', () => {
  const enCarrito = [{ uuid: 'x', recepcionId: FILA }]
  const res = resolverToma({ ...TOMA_ARGS, filaExacta: filaDe({}), carrito: enCarrito })
  assert.strictEqual(res.estado, 'rechazada')
  assert.strictEqual(res.razon, 'PALETA_YA_EN_CARRITO')
})

t('ruta exacta: código ajeno a la RQ → CODIGO_AJENO', () => {
  const res = resolverToma({ ...TOMA_ARGS, codigoRq: '99999', filaExacta: filaDe({}) })
  assert.strictEqual(res.estado, 'rechazada')
  assert.strictEqual(res.razon, 'CODIGO_AJENO')
})

t('ruta exacta: paleta de la fila va a la toma', () => {
  const res = resolverToma({ ...TOMA_ARGS, filaExacta: filaDe({ nPaleta: 3 }) })
  assert.strictEqual(res.estado, 'ok')
  assert.strictEqual(res.toma.paleta, 3)
})

t('ruta legada: uuid de guía en el QR sigue resolviendo por FEFO entre candidatas', () => {
  const f1 = filaDe({ id: '22222222-2222-4222-8222-222222222222', fechaVencimiento: '2027-06-01' })
  const f2 = filaDe({ id: '33333333-3333-4333-8333-333333333333', fechaVencimiento: '2027-01-01' })
  const textoLegado = `${PREFIJO_QR}|${GUIA}|T173-00005000|43684`
  const res = resolverToma({ texto: textoLegado, codigoRq: '43684', filas: [f1, f2], carrito: [], nuevoUuid: () => 'u2' })
  assert.strictEqual(res.estado, 'ok')
  // FEFO: menor vencimiento primero → f2
  assert.strictEqual(res.toma.recepcionId, f2.id)
})

console.log(`\n${ok} tests OK`)
