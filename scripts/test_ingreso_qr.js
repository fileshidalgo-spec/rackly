/**
 * RACKLY — Tests de la lib de INGRESO POR QR en Racks > Ocupaciones
 * (lib/rackly/ingreso-qr.ts — pura, sin red).
 * Ejecutar:
 *   npx esbuild scripts/test_ingreso_qr.js --bundle --platform=node \
 *     --outfile=scripts/.testbuild/test_ingreso_qr.cjs --alias:@=./src --loader:.ts=ts \
 *   && node scripts/.testbuild/test_ingreso_qr.cjs
 */
const assert = require('assert')
const {
  rotuloDesdeFila,
  prefillDesdeRotulo,
  validarCantidadRotulo,
  etiquetaPosicionRack,
} = require('@/lib/rackly/ingreso-qr')
const { parsearPayloadQR, construirPayloadQR } = require('@/lib/rackly/qr-rotulo')
const { mapArticuloTransito } = require('@/lib/rackly/transito-core')

let ok = 0
function t(nombre, fn) {
  try {
    fn()
    ok++
    console.log('  ✓', nombre)
  } catch (e) {
    console.error('  ✗', nombre, '\n    ', e.message)
    process.exitCode = 1
  }
}

// Fila real del incidente 2026-10-29 (37934 — 81000 UN, venc absurdo 3027).
const FILA_INCIDENTE = mapArticuloTransito({
  id: '8c16a5ab-7d36-4ed8-b749-1cb5351816fb',
  guia_id: '8d8b3ddb-be99-4da4-9ec2-fb538307b25f',
  created_at: '2026-10-29 04:27:20.363556+00',
  fecha: '2026-10-28',
  tipo_documento: 'T',
  numero_documento: 'T173-00005555',
  empresa_origen: 'ECARAL S.A.',
  proveedor: 'PROVEEDOR X',
  codigo: '37934',
  descripcion: 'TAPA PLANA 33 MM ROJO HF (SAN MIGUEL)',
  cantidad: '81000',
  unidad_medida: 'UN',
  lote: '260731A13C',
  fecha_produccion: '2026-07-31',
  fecha_vencimiento: '3027-07-31',
  placa: '',
  n_paleta: null,
  usuario_nombre: 'Recepción',
  observaciones: null,
  transito: null,
})

const FILA_PARCIAL = mapArticuloTransito({
  ...FILA_INCIDENTE,
  id: 'fila-parcial-0002',
  cantidad: '100',
  transito: { v: 1, envios: [{ uuid: 'u1', fecha: '2026-10-29 10:00', destino: 'rack', ubicacion: 'B1·T1·P1·Pos1', cantidad: 40 }] },
})

console.log('rotuloDesdeFila')
t('fila sin envíos → pendiente = cantidad, yaTransferido=false', () => {
  const r = rotuloDesdeFila(FILA_INCIDENTE)
  assert.strictEqual(r.recepcionId, '8c16a5ab-7d36-4ed8-b749-1cb5351816fb')
  assert.strictEqual(r.pendiente, 81000)
  assert.strictEqual(r.cantidadTotal, 81000)
  assert.strictEqual(r.yaTransferido, false)
  assert.strictEqual(r.numeroDocumento, 'T173-00005555')
  assert.strictEqual(r.lote, '260731A13C')
  assert.strictEqual(r.fechaVencimiento, '3027-07-31')
  assert.strictEqual(r.unidadMedida, 'UN')
})
t('fila con envío parcial → pendiente = cantidad - enviado', () => {
  const r = rotuloDesdeFila(FILA_PARCIAL)
  assert.strictEqual(r.pendiente, 60)
  assert.strictEqual(r.yaTransferido, false)
})
t('fila 100% transferida → yaTransferido=true', () => {
  const completa = mapArticuloTransito({
    ...FILA_INCIDENTE,
    cantidad: '100',
    transito: { v: 1, envios: [{ uuid: 'u1', fecha: '2026-10-29 10:00', destino: 'rack', ubicacion: 'B1·T1·P1·Pos1', cantidad: 100 }] },
  })
  const r = rotuloDesdeFila(completa)
  assert.strictEqual(r.pendiente, 0)
  assert.strictEqual(r.yaTransferido, true)
})

console.log('\nprefillDesdeRotulo')
t('prefill completo: cantidad = pendiente, toggles según datos', () => {
  const pf = prefillDesdeRotulo(rotuloDesdeFila(FILA_INCIDENTE))
  assert.strictEqual(pf.codigo, '37934')
  assert.strictEqual(pf.descripcion, 'TAPA PLANA 33 MM ROJO HF (SAN MIGUEL)')
  assert.strictEqual(pf.un, 'UN')
  assert.strictEqual(pf.cantidad, '81000')
  assert.strictEqual(pf.lote, '260731A13C')
  assert.strictEqual(pf.fVenc, '3027-07-31')
  assert.strictEqual(pf.sinFecha, false)
  assert.strictEqual(pf.sinLote, false)
})
t('prefill sin lote ni vencimiento → toggles activados', () => {
  const sinDatos = mapArticuloTransito({
    ...FILA_INCIDENTE,
    lote: '',
    fecha_vencimiento: null,
  })
  const pf = prefillDesdeRotulo(rotuloDesdeFila(sinDatos))
  assert.strictEqual(pf.lote, '')
  assert.strictEqual(pf.sinLote, true)
  assert.strictEqual(pf.fVenc, '')
  assert.strictEqual(pf.sinFecha, true)
})
t('prefill redondea pendiente binario (0.1+0.2)', () => {
  const r = { ...rotuloDesdeFila(FILA_PARCIAL), pendiente: 0.30000000000000004 }
  const pf = prefillDesdeRotulo(r)
  assert.strictEqual(pf.cantidad, '0.3')
})

console.log('\nvalidarCantidadRotulo')
const rotulo = rotuloDesdeFila(FILA_INCIDENTE)
t('cantidad ≤ pendiente → null', () => {
  assert.strictEqual(validarCantidadRotulo(81000, rotulo), null)
  assert.strictEqual(validarCantidadRotulo(1, rotulo), null)
})
t('cantidad > pendiente → mensaje con pendiente y guía a quitar el rótulo', () => {
  const out = validarCantidadRotulo(82000, rotulo)
  assert.ok(out && out.includes('81000'), out)
  assert.ok(out.includes('Quita el rótulo'.toLowerCase()) || out.toLowerCase().includes('quita el rótulo'), out)
})
t('cantidad 0/negativa/NaN → error', () => {
  assert.ok(validarCantidadRotulo(0, rotulo))
  assert.ok(validarCantidadRotulo(-1, rotulo))
})
t('rótulo yaTransferido → NO bloquea (vía genérica decide, aviso ya mostrado)', () => {
  const r = rotuloDesdeFila(FILA_PARCIAL)
  const yaListo = { ...r, yaTransferido: true, pendiente: 0 }
  assert.strictEqual(validarCantidadRotulo(5, yaListo), null)
})

console.log('\netiquetaPosicionRack')
t('formato B·T·P·Pos', () => {
  assert.strictEqual(etiquetaPosicionRack({ bloque: '3', torre: '1', piso: '4', posicion: '1' }), 'B3·T1·P4·Pos1')
})

console.log('\nintegración con el contrato del QR (qr-rotulo)')
t('payload del rótulo nuevo parsea y resuelve a la fila del incidente', () => {
  const payload = construirPayloadQR({
    identidad: '8c16a5ab-7d36-4ed8-b749-1cb5351816fb',
    numeroDocumento: 'T173-00005555',
    codigo: '37934',
    paleta: null,
  })
  const p = parsearPayloadQR(payload)
  assert.ok(p, 'parseo falló')
  assert.strictEqual(p.identidad, '8c16a5ab-7d36-4ed8-b749-1cb5351816fb')
  const r = rotuloDesdeFila({ ...FILA_INCIDENTE })
  assert.strictEqual(r.recepcionId, p.identidad)
})
t('payload con paleta P3 parsea', () => {
  const p = parsearPayloadQR('RKLY|abc-uuid|T001|37934|P3')
  assert.strictEqual(p.paleta, 3)
})
t('texto ajeno → null (no lanza)', () => {
  assert.strictEqual(parsearPayloadQR('https://ejemplo.pe/xyz'), null)
  assert.strictEqual(parsearPayloadQR(''), null)
})

console.log(`\n${ok} checks OK${process.exitCode ? ' (con fallos)' : ''}`)
