/**
 * RACKLY — Tests del núcleo TRÁNSITO (semáforo, agrupación, validaciones).
 * Ejecutar:
 *   npx esbuild scripts/test_transito.js --bundle --platform=node \
 *     --outfile=scripts/.testbuild/test_transito.cjs --alias:@=./src --loader:.ts=ts \
 *   && node scripts/.testbuild/test_transito.cjs
 */
const assert = require('assert')
const {
  FECHA_INICIO_TRANSITO,
  EPS_TRANSITO,
  estadoSem,
  razonNoTransferible,
  esTransferible,
  parseEnvios,
  mapArticuloTransito,
  claveGuia,
  agruparEnGuias,
  contarPendientes,
  filtrarArticulos,
  etiquetaRack,
  etiquetaPiso,
  claveCeldaRack,
  validarCantidad,
  mensajeRpcError,
} = require('@/lib/rackly/transito-core')

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

console.log('— transito-core —')

// ── Constantes ──
t('FECHA_INICIO_TRANSITO = 2026-10-13 (fecha de implementación)', () => {
  assert.strictEqual(FECHA_INICIO_TRANSITO, '2026-10-13')
})
t('EPS_TRANSITO = 0.0005', () => {
  assert.strictEqual(EPS_TRANSITO, 0.0005)
})

// ── Semáforo ──
const envio = (cantidad, extra = {}) => ({
  uuid: 'u-' + Math.random().toString(36).slice(2),
  fecha: '2026-10-14 09:00',
  destino: 'rack',
  ubicacion: 'B9·T1·P1·Pos1',
  cantidad,
  usuario_id: null,
  usuario_nombre: 'Tester',
  turno: 'Día',
  ...extra,
})

t('semáforo: ROJO con 0 enviados', () => {
  const r = estadoSem({ cantidad: 10, envios: [] })
  assert.strictEqual(r.estado, 'ROJO')
  assert.strictEqual(r.enviados, 0)
  assert.strictEqual(r.pendiente, 10)
})

t('semáforo: AMAR con envío parcial (4/10 → quedan 6)', () => {
  const r = estadoSem({ cantidad: 10, envios: [envio(4)] })
  assert.strictEqual(r.estado, 'AMAR')
  assert.strictEqual(r.enviados, 4)
  assert.strictEqual(r.pendiente, 6)
})

t('semáforo: VERDE al completar (4+6/10)', () => {
  const r = estadoSem({ cantidad: 10, envios: [envio(4), envio(6)] })
  assert.strictEqual(r.estado, 'VERDE')
  assert.strictEqual(r.enviados, 10)
  assert.strictEqual(r.pendiente, 0)
})

t('semáforo: decimales sin residuo binario (0.1+0.2 ≠ 0.30000000000000004)', () => {
  const r = estadoSem({ cantidad: 0.3, envios: [envio(0.1), envio(0.2)] })
  assert.strictEqual(r.estado, 'VERDE')
  assert.strictEqual(r.pendiente, 0)
})

t('semáforo: 3 artículos de una paleta a la misma celda → 3 envíos → 3 VERDE', () => {
  const arts = [1, 2, 3].map((n) => ({ cantidad: 5, envios: [envio(5)] }))
  for (const a of arts) assert.strictEqual(estadoSem(a).estado, 'VERDE')
})

t('semáforo: defensivo — enviar más de la cantidad → VERDE con pendiente ≤ 0', () => {
  const r = estadoSem({ cantidad: 5, envios: [envio(5), envio(2)] })
  assert.strictEqual(r.estado, 'VERDE')
  assert.ok(r.pendiente <= 0)
})

// ── Regla sin lote / sin vencimiento ──
t('razonNoTransferible: sin ambos', () => {
  assert.strictEqual(razonNoTransferible({ lote: '', fechaVencimiento: null }), 'Sin lote y sin fecha de vencimiento')
})
t('razonNoTransferible: solo sin lote', () => {
  assert.strictEqual(razonNoTransferible({ lote: '  ', fechaVencimiento: '2027-01-01' }), 'Sin lote')
})
t('razonNoTransferible: solo sin vencimiento', () => {
  assert.strictEqual(razonNoTransferible({ lote: 'L1', fechaVencimiento: null }), 'Sin fecha de vencimiento')
})
t('razonNoTransferible: con todo → transferible', () => {
  assert.strictEqual(razonNoTransferible({ lote: 'L1', fechaVencimiento: '2027-01-01' }), '')
  assert.strictEqual(esTransferible({ lote: 'L1', fechaVencimiento: '2027-01-01' }), true)
  assert.strictEqual(esTransferible({ lote: '', fechaVencimiento: null }), false)
})

// ── parseEnvios / mapArticuloTransito ──
t('parseEnvios: tolera null y filtra filas sin uuid', () => {
  assert.deepStrictEqual(parseEnvios(null), [])
  assert.deepStrictEqual(parseEnvios('x'), [])
  const r = parseEnvios([envio(1), { foo: 'bar' }, { uuid: '' }])
  assert.strictEqual(r.length, 1)
})

t('mapArticuloTransito: mapea fila completa con transito jsonb y deriva semáforo', () => {
  const fila = {
    id: 'f1',
    created_at: '2026-10-14T09:00:00Z',
    fecha: '2026-10-14',
    tipo_documento: 'Guia',
    numero_documento: '123',
    proveedor: 'ACME',
    codigo: 'A1',
    descripcion: 'Producto',
    cantidad: 10,
    unidad_medida: 'UN',
    lote: 'L1',
    fecha_produccion: '2026-10-01',
    fecha_vencimiento: '2027-01-01',
    placa: 'ABC-123',
    n_paleta: 2,
    guia_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    usuario_nombre: 'Miguel',
    transito: { v: 1, envios: [envio(4)] },
  }
  const a = mapArticuloTransito(fila)
  assert.strictEqual(a.codigo, 'A1')
  assert.strictEqual(a.nPaleta, 2)
  // guiaId (2026-10): identidad que porta el QR del rótulo — el lector de
  // Tránsito resuelve la guía por aquí.
  assert.strictEqual(a.guiaId, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')
  assert.strictEqual(a.envios.length, 1)
  assert.strictEqual(a.enviados, 4)
  assert.strictEqual(a.pendiente, 6)
  assert.strictEqual(a.estado, 'AMAR')
  assert.strictEqual(a.transferible, true)
})

t('mapArticuloTransito: sin transito → ROJO', () => {
  const a = mapArticuloTransito({
    id: 'f2', cantidad: 7, lote: 'L', fecha_vencimiento: '2027-01-01',
    codigo: 'X', unidad_medida: 'UN', fecha: '2026-10-14', tipo_documento: 'Guia',
  })
  assert.strictEqual(a.estado, 'ROJO')
  assert.strictEqual(a.pendiente, 7)
  assert.strictEqual(a.nPaleta, null)
})

// ── Agrupación de guías ──
const art = (over = {}) => ({
  id: Math.random().toString(36).slice(2),
  createdAt: '2026-10-14T10:00:00Z',
  fecha: '2026-10-14',
  tipoDocumento: 'Guia',
  numeroDocumento: 'G-100',
  proveedor: 'ACME',
  codigo: 'A',
  descripcion: 'd',
  cantidad: 1,
  unidadMedida: 'UN',
  lote: 'L',
  fechaProduccion: '',
  fechaVencimiento: '2027-01-01',
  placa: 'P1',
  nPaleta: null,
  usuarioNombre: 'u',
  observaciones: '',
  envios: [],
  enviados: 0,
  pendiente: 1,
  estado: 'ROJO',
  transferible: true,
  razonNoTransferible: '',
  ...over,
})

t('claveGuia: con nº documento → tipo|número', () => {
  assert.strictEqual(claveGuia({ tipoDocumento: 'Guia', numeroDocumento: 'G1', fecha: 'x', proveedor: 'y' }), 'Guia|G1')
})
t('claveGuia: sin nº → fecha|proveedor|tipo', () => {
  assert.strictEqual(
    claveGuia({ tipoDocumento: 'Guia', numeroDocumento: '', fecha: '2026-10-14', proveedor: 'ACME' }),
    '2026-10-14|ACME|Guia'
  )
})

t('agruparEnGuias: agrupa por documento y ordena artículos por registro', () => {
  const guias = agruparEnGuias([
    art({ id: 'b', createdAt: '2026-10-14T11:00:00Z' }),
    art({ id: 'a', createdAt: '2026-10-14T09:00:00Z' }),
    art({ id: 'c', createdAt: '2026-10-14T10:00:00Z', numeroDocumento: 'G-200' }),
  ])
  assert.strictEqual(guias.length, 2)
  const g100 = guias.find((g) => g.numeroDocumento === 'G-100')
  assert.deepStrictEqual(g100.articulos.map((x) => x.id), ['a', 'b'])
})

t('agruparEnGuias: guías más recientes primero', () => {
  const guias = agruparEnGuias([
    art({ fecha: '2026-10-12', numeroDocumento: 'VIEJA' }),
    art({ fecha: '2026-10-14', numeroDocumento: 'NUEVA' }),
  ])
  assert.strictEqual(guias[0].numeroDocumento, 'NUEVA')
})

t('contarPendientes: solo artículos con pendiente > 0', () => {
  const n = contarPendientes([
    art({ id: '1', pendiente: 0, estado: 'VERDE' }),
    art({ id: '2', pendiente: 3, estado: 'AMAR' }),
    art({ id: '3', pendiente: 5, estado: 'ROJO' }),
  ])
  assert.strictEqual(n, 2)
})

t('filtrarArticulos: proveedor, código, descripción y nº doc (insensible a mayúsculas)', () => {
  const lista = [
    art({ id: '1', proveedor: 'Ajeper', codigo: 'ZZ1', descripcion: 'Harina', numeroDocumento: 'G-1' }),
    art({ id: '2', proveedor: 'Otro', codigo: 'ACIDO', descripcion: 'x', numeroDocumento: 'G-2' }),
  ]
  assert.strictEqual(filtrarArticulos(lista, 'ajep').length, 1)
  assert.strictEqual(filtrarArticulos(lista, 'acido').length, 1)
  assert.strictEqual(filtrarArticulos(lista, 'harina').length, 1)
  assert.strictEqual(filtrarArticulos(lista, 'g-2').length, 1)
  assert.strictEqual(filtrarArticulos(lista, '   ').length, 2)
  assert.strictEqual(filtrarArticulos(lista, 'nadaquever').length, 0)
})

// ── Validaciones ──
t('validarCantidad: 0 y negativo inválidos', () => {
  assert.ok(validarCantidad(0, 10))
  assert.ok(validarCantidad(-1, 10))
})
t('validarCantidad: excede el pendiente con excedente en el mensaje', () => {
  const m = validarCantidad(7, 6)
  assert.ok(m.includes('6') && m.includes('1'), m)
})
t('validarCantidad: igual al pendiente → ok; tolerancia decimal', () => {
  assert.strictEqual(validarCantidad(6, 6), null)
  assert.strictEqual(validarCantidad(0.3, 0.3000005), null)
})
t('mensajeRpcError: extrae detalle tras "|"', () => {
  const e = new Error('OVER_ISSUE|La cantidad excede el pendiente')
  assert.strictEqual(mensajeRpcError(e), 'La cantidad excede el pendiente')
  assert.strictEqual(mensajeRpcError(new Error('simple')), 'simple')
})

// ── Etiquetas ──
t('etiquetaRack / etiquetaPiso / claveCeldaRack', () => {
  assert.strictEqual(etiquetaRack({ bloque: '3', torre: '2', piso: '1', posicion: '07' }), 'B3·T2·P1·Pos07')
  assert.strictEqual(
    etiquetaPiso({ sector: 'S1', columna: 'A', subcolumna: 'A2', posicionNumero: 3, nivelNumero: 2 }),
    'S1·A·A2·Pos3·N2'
  )
  assert.strictEqual(claveCeldaRack({ bloque: '1', torre: '1', piso: '1', posicion: '1' }), '1-1-1-1')
})

console.log(`\nRESULTADO: ${ok} tests OK`)
