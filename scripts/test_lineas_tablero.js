#!/usr/bin/env node
/**
 * RACKLY — 2026-11-12 · LÍNEAS canónicas + TABLERO de atenciones por línea.
 *
 * Suite PURA (sin stub — ni lineas.ts ni atencion-tablero.ts tocan red):
 *   A. lineas.ts: 22 opciones (Línea 1–20 + Materiales auxiliares + Jarabe),
 *      normalizador OCR/histórico, clave de orden canónica.
 *   B. atencion-tablero.ts: fecha Lima, turno de la toma (columna o
 *      derivado), filtro rango+turnos, NETO con reversas, agrupación
 *      línea+sku (2.ª iteración 2026-11-12: el MISMO código se suma en una
 *      fila por línea, producto dominante), fallback de producto, orden.
 */
const {
  LINEAS_OPCIONES,
  LINEA_AUXILIARES,
  LINEA_JARABE,
  esLineaCanonica,
  normalizarLinea,
  lineaParaAgrupar,
  claveOrdenLinea,
} = require('../src/lib/rackly/lineas')
const {
  fechaLimaISO,
  turnoDeToma,
  productoDeRq,
  construirTablero,
} = require('../src/lib/rackly/atencion-tablero')

let ok = 0
function check(nombre, cond) {
  if (!cond) {
    console.error(`✗ ${nombre}`)
    process.exitCode = 1
  } else {
    ok++
    console.log(`✓ ${nombre}`)
  }
}

// ── A. lineas.ts ──────────────────────────────────────────────────────
check('A1 · 22 opciones canónicas', LINEAS_OPCIONES.length === 22)
check('A2 · Línea 1..20 presentes', LINEAS_OPCIONES[0] === 'Línea 1' && LINEAS_OPCIONES[19] === 'Línea 20')
check('A3 · Materiales auxiliares en 21', LINEAS_OPCIONES[20] === 'Materiales auxiliares')
check('A3b · Jarabe en 22 (pedido 2026-11-12)', LINEAS_OPCIONES[21] === 'Jarabe' && LINEA_JARABE === 'Jarabe')
check('A4 · «Línea 7» es canónica', esLineaCanonica('Línea 7'))
check('A5 · «LINEA 7» NO es canónica', !esLineaCanonica('LINEA 7'))

check('A6 · normaliza «LINEA 2»', normalizarLinea('LINEA 2') === 'Línea 2')
check('A7 · normaliza «Linea 02»', normalizarLinea('Linea 02') === 'Línea 2')
check('A8 · normaliza «linea2»', normalizarLinea('linea2') === 'Línea 2')
check('A9 · normaliza «L7»', normalizarLinea('L7') === 'Línea 7')
check('A10 · normaliza «L-07»', normalizarLinea('L-07') === 'Línea 7')
check('A11 · normaliza «L 12»', normalizarLinea('L 12') === 'Línea 12')
check('A12 · normaliza «7»', normalizarLinea('7') === 'Línea 7')
check('A13 · normaliza «AUXILIAR»', normalizarLinea('AUXILIAR') === LINEA_AUXILIARES)
check('A14 · normaliza «MATERIALES AUXILIARES»', normalizarLinea('MATERIALES AUXILIARES') === LINEA_AUXILIARES)
check('A15 · normaliza «mat aux»', normalizarLinea('mat aux') === LINEA_AUXILIARES)
check('A16 · «JARABES» → Jarabe (pedido 2026-11-12)', normalizarLinea('JARABES') === 'Jarabe')
check('A17 · «60 TANQUES DE JARABE GASEOSA» → Jarabe', normalizarLinea('60 TANQUES DE JARABE GASEOSA') === 'Jarabe')
check('A17b · «Jarabe de Pulp» → Jarabe', normalizarLinea('Jarabe de Pulp') === 'Jarabe')
check('A17c · «Jarabe» canónico pasa igual', normalizarLinea('Jarabe') === 'Jarabe')
check('A18 · NO inventa fuera de rango «LINEA 25»', normalizarLinea('LINEA 25') === '')
check('A19 · vacío → vacío', normalizarLinea('  ') === '')
check('A20 · canonical pasa igual', normalizarLinea('Línea 15') === 'Línea 15')

check('A21 · agrupar: vacío → (sin línea)', lineaParaAgrupar('') === '(sin línea)')
check('A22 · agrupar: «JARABES» → Jarabe (se agrupa con la canónica)', lineaParaAgrupar('JARABES') === 'Jarabe')
check('A23 · agrupar: «LINEA 9» → Línea 9', lineaParaAgrupar('LINEA 9') === 'Línea 9')

check('A24 · orden: Línea 1 < Línea 2 < Materiales auxiliares < Jarabe < históricos',
  claveOrdenLinea('Línea 1')[0] === 0 &&
  claveOrdenLinea('Línea 2')[0] === 0 &&
  claveOrdenLinea(LINEA_AUXILIARES)[0] === 0 &&
  claveOrdenLinea(LINEA_JARABE)[0] === 0 &&
  claveOrdenLinea(LINEA_AUXILIARES)[1] < claveOrdenLinea(LINEA_JARABE)[1] &&
  claveOrdenLinea('JARABES')[0] === 1)

// ── B. atencion-tablero.ts ────────────────────────────────────────────
// Fechas de referencia (UTC → hora Lima = UTC-5):
//   2026-11-10T15:00:00Z → 10:00 Lima (T1, día 10)
//   2026-11-11T01:00:00Z → 20:00 Lima (T2, día 10)
//   2026-11-11T12:30:00Z → 07:30 Lima (T1, día 11)
//   2026-11-10T22:00:00Z → 17:00 Lima (T1, día 10)
check('B1 · fechaLimaISO UTC→Lima cruzando día', fechaLimaISO('2026-11-11T01:00:00Z') === '2026-11-10')
check('B2 · fechaLimaISO mismo día', fechaLimaISO('2026-11-10T15:00:00Z') === '2026-11-10')
check('B3 · fechaLimaISO vacío/inválido', fechaLimaISO('') === '' && fechaLimaISO('no-es-fecha') === '')

const tomaDe = (creadoEn, turno) => ({ rqId: 'rq-1', itemId: 'it-1', codigo: '118', origen: 'manual', cantidad: 5, ubicacion: '', saldoResultante: null, lote: '', usuarioNombre: 'U', turno: turno ?? '', creadoEn })
check('B4 · turno de la toma: usa la columna si vino', turnoDeToma(tomaDe('2026-11-10T22:00:00Z', 'T2')) === 'T2')
check('B5 · turno derivado (10:00 Lima → T1)', turnoDeToma(tomaDe('2026-11-10T15:00:00Z')) === 'T1')
check('B6 · turno derivado (20:00 Lima → T2)', turnoDeToma(tomaDe('2026-11-11T01:00:00Z')) === 'T2')
check('B7 · turno derivado (07:30 Lima → T1)', turnoDeToma(tomaDe('2026-11-11T12:30:00Z')) === 'T1')
check('B8 · turno derivado (06:50 Lima → T2)', turnoDeToma(tomaDe('2026-11-11T11:50:00Z')) === 'T2')
check('B9 · turno derivado (19:20 Lima → T1, inclusive)', turnoDeToma(tomaDe('2026-11-11T00:20:00Z')) === 'T1')

check('B10 · producto: descripción de la OP',
  productoDeRq({ id: 'x', productoDescripcion: 'SPORADE TROPICAL', productoCodigo: 'SP1', linea: 'Línea 2' }, 'Línea 2') === 'SPORADE TROPICAL')
check('B11 · producto: MATERIALES AUXILIARES en línea auxiliar sin OP',
  productoDeRq({ id: 'x', productoDescripcion: '', productoCodigo: '', linea: 'Materiales auxiliares' }, 'Materiales auxiliares') === 'MATERIALES AUXILIARES')
check('B12 · producto: (sin producto) si no hay nada',
  productoDeRq({ id: 'x', productoDescripcion: '', productoCodigo: '', linea: 'Línea 5' }, 'Línea 5') === '(sin producto)')

// ── B.2 construirTablero (fixtures) ───────────────────────────────────
const rqs = [
  { id: 'rq-1', fecha: '2026-11-10', numeroRq: '0000190001', ordenProduccion: 'OP-1', productoCodigo: 'SP1', productoDescripcion: 'SPORADE TROPICAL', turno: 'T1', turnoRq: 'T1', linea: 'LINEA 2', solicitante: 'U', estado: 'Atendido', notas: '', usuarioNombre: 'U', createdAt: '2026-11-10T12:00:00Z' },
  { id: 'rq-2', fecha: '2026-11-10', numeroRq: '0000190002', ordenProduccion: '', productoCodigo: '', productoDescripcion: '', turno: 'T1', turnoRq: 'T1', linea: 'AUXILIARES', solicitante: 'U', estado: 'Pendiente', notas: '', usuarioNombre: 'U', createdAt: '2026-11-10T12:00:00Z' },
  { id: 'rq-3', fecha: '2026-11-10', numeroRq: '0000190003', ordenProduccion: 'OP-2', productoCodigo: '', productoDescripcion: 'VOLT ORIGINAL', turno: 'T2', turnoRq: 'T2', linea: 'LINEA 2', solicitante: 'U', estado: 'Atendido', notas: '', usuarioNombre: 'U', createdAt: '2026-11-10T18:00:00Z' },
]
const items = [
  { id: 'it-1', rqId: 'rq-1', orden: 0, codigo: '118', descripcion: 'ÁCIDO CÍTRICO', unidad: 'KG', cantidad: 10, cantidadAtendida: 10, usuarioAtencion: 'U', atendidoEn: '' },
  { id: 'it-2', rqId: 'rq-2', orden: 0, codigo: 'AC-101', descripcion: 'ALCALINO LIMPIEZA AC-101', unidad: 'UN', cantidad: 2, cantidadAtendida: 0, usuarioAtencion: '', atendidoEn: '' },
  { id: 'it-3', rqId: 'rq-3', orden: 0, codigo: '118', descripcion: 'ÁCIDO CÍTRICO', unidad: 'KG', cantidad: 7, cantidadAtendida: 7, usuarioAtencion: 'U', atendidoEn: '' },
]
const tomas = [
  // rq-1 / Línea 2 / SPORADE: 3 salidas + 1 reversa → neto 5+5+5-5 = 10
  tomaDe('2026-11-10T15:00:00Z'), // T1 día 10
  { ...tomaDe('2026-11-10T16:00:00Z'), cantidad: 5, itemId: 'it-1' },
  { ...tomaDe('2026-11-10T17:00:00Z'), cantidad: 5, itemId: 'it-1' },
  { ...tomaDe('2026-11-10T18:00:00Z'), cantidad: -5, itemId: 'it-1', origen: 'reversa' },
  // rq-3 / Línea 2 (producto VOLT) T2 día 10 (20:00 Lima) → neto 7
  { ...tomaDe('2026-11-11T01:00:00Z'), rqId: 'rq-3', itemId: 'it-3', cantidad: 7 },
  // rq-2 / Materiales auxiliares T2 día 10 → 2
  { ...tomaDe('2026-11-11T01:30:00Z'), rqId: 'rq-2', itemId: 'it-2', codigo: 'AC-101', cantidad: 2 },
  // FUERA de rango (día 11) — no entra con filtro día 10
  { ...tomaDe('2026-11-11T12:30:00Z'), rqId: 'rq-1', itemId: 'it-1', cantidad: 99 },
]
const datos = { rqs, items, tomas, vencimientos: new Map() }

const t = construirTablero(datos, { desde: '2026-11-10', hasta: '2026-11-10', turnos: ['T1', 'T2'] })
// 2.ª iteración (pedido 2026-11-12): el MISMO código se suma en UNA fila
// por línea — sku 118 salió para SPORADE (10) y VOLT (7) → una fila de 17.
check('B13 · suma el mismo código en la línea: sku 118 neto 17 (10 SPORADE + 7 VOLT)',
  t.filas.some((f) => f.linea === 'Línea 2' && f.sku === '118' && f.cantidad === 17))
check('B14 · producto dominante: SPORADE (10 > 7) en la fila sumada',
  t.filas.filter((f) => f.linea === 'Línea 2').length === 1 &&
  t.filas[0].producto === 'SPORADE TROPICAL')
check('B14b · numTomas de la fila sumada = 5 (4 SPORADE + 1 VOLT)', t.filas[0].numTomas === 5)
check('B15 · agrupa: AUXILIARES → Materiales auxiliares + producto MATERIALES AUXILIARES', t.filas.some((f) => f.linea === 'Materiales auxiliares' && f.producto === 'MATERIALES AUXILIARES' && f.cantidad === 2))
check('B16 · excluye lo fuera de rango (99 no entra)', !t.filas.some((f) => f.cantidad === 99))
check('B17 · tomasEnRango = 6', t.tomasEnRango === 6)
check('B18 · totalGeneral = 19', t.totalGeneral === 19)
check('B19 · subtotal Línea 2 = 17', t.subtotales.get('Línea 2') === 17)
check('B20 · orden: Línea 2 antes que Materiales auxiliares', t.filas[0].linea === 'Línea 2')

const t1solo = construirTablero(datos, { desde: '2026-11-10', hasta: '2026-11-10', turnos: ['T1'] })
check('B21 · filtro turno T1 solo: neto sku 118 = 10 (las 4 salidas T1)', t1solo.filas.filter((f) => f.linea === 'Línea 2').every((f) => f.cantidad === 10))
check('B22 · filtro turno T1: VOLT (T2) no entra', !t1solo.filas.some((f) => f.linea === 'Materiales auxiliares') && t1solo.filas.length === 1)
check('B23 · filtro turno T1: auxiliares (T2) no entra', !t1solo.filas.some((f) => f.linea === 'Materiales auxiliares'))

const tRango = construirTablero(datos, { desde: '2026-11-10', hasta: '2026-11-11', turnos: ['T1', 'T2'] })
// rango ampliado: sku 118 = 10 (SPORADE) + 99 (fuera de rango antes) + 7 (VOLT) = 116
check('B24 · rango ampliado suma todo el sku 118 en una fila (neto 116)', tRango.filas.some((f) => f.linea === 'Línea 2' && f.cantidad === 116))

const tRqBorrada = construirTablero(
  { rqs, items, tomas: [{ ...tomaDe('2026-11-10T15:00:00Z'), rqId: 'rq-eliminada' }], vencimientos: new Map() },
  { desde: '2026-11-10', hasta: '2026-11-10', turnos: ['T1'] }
)
check('B25 · RQ eliminada → grupo (sin RQ)', tRqBorrada.filas.some((f) => f.linea === '(sin RQ)'))

console.log(`— lineas+tablero: ${ok} checks —`)
if (process.exitCode) process.exit(1)
