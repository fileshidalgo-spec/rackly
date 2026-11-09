/**
 * RACKLY · Tests REPUESTOS — Mapeo Excel (rep-excel, lógica PURA).
 *
 * Cubre: detección de columnas con sinónimos/acentos, conversión de
 * cantidades (formatos "1,500.50" / "1.500,50" / "12" / vacío), filas
 * válidas/descartadas y dedup por código dentro del archivo.
 */
const assert = require('node:assert')
const { repDetectarColumnas, repMapearFilas, repNumeroDeCelda } = require('@/lib/rackly/rep/rep-excel')

let n = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`FALLO #${++n}: ${msg}`)
  n++
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`FALLO #${++n}: ${msg}\n  esperado: ${JSON.stringify(b)}\n  recibido: ${JSON.stringify(a)}`)
  }
  n++
}

// ── Detección de columnas ──
eq(
  repDetectarColumnas(['CODIGO', 'DESCRIPCIÓN', 'UND', 'CANTIDAD']),
  { codigo: 'CODIGO', descripcion: 'DESCRIPCIÓN', und: 'UND', cantidad: 'CANTIDAD' },
  'encabezados exactos del formato acordado'
)
eq(
  repDetectarColumnas(['Codigo Articulo', 'Descripcion del repuesto', 'Unidad', 'Cant. Ref']),
  { codigo: 'Codigo Articulo', descripcion: 'Descripcion del repuesto', und: 'Unidad', cantidad: 'Cant. Ref' },
  'sinónimos y compuestos'
)
// Cae a convención posicional si los encabezados no dicen nada
eq(
  repDetectarColumnas(['Col A', 'Col B', 'Col C']),
  { codigo: 'Col A', descripcion: 'Col B', und: null, cantidad: null },
  'fallback posicional (1ª=código, 2ª=descripción)'
)
ok(repDetectarColumnas([]) === null, 'hoja sin encabezados → null')

// ── Conversión de cantidades (cantidad_ref es solo referencia) ──
ok(repNumeroDeCelda(1500) === 1500, 'número directo')
ok(repNumeroDeCelda('12') === 12, 'texto simple')
ok(repNumeroDeCelda('1,500.50') === 1500.5, 'formato US 1,500.50')
ok(repNumeroDeCelda('1.500,50') === 1500.5, 'formato PE 1.500,50')
ok(repNumeroDeCelda('1,500') === 1500, '1,500 → miles (no decimal)')
ok(repNumeroDeCelda('1,5') === 1.5, '1,5 → decimal')
ok(repNumeroDeCelda('12 und') === 12, 'con texto pegado')
ok(repNumeroDeCelda('') === 0, 'vacío → 0')
ok(repNumeroDeCelda(null) === 0, 'null → 0')
ok(repNumeroDeCelda('n/d') === 0, 'basura → 0 (nunca lanza)')

// ── Mapeo de filas ──
const col = repDetectarColumnas(['CODIGO', 'DESCRIPCIÓN', 'UND', 'CANTIDAD'])
const hoja = [
  { CODIGO: 'bj-109-003', DESCRIPCIÓN: 'Filtro de aire', UND: 'UND', CANTIDAD: 4 },
  { CODIGO: 'BJ-200-001', DESCRIPCIÓN: 'Aceite 15W40', UND: 'GLN', CANTIDAD: '1,200.5' },
  { CODIGO: '', DESCRIPCIÓN: 'sin código', UND: '', CANTIDAD: '' },
  { CODIGO: 'BJ-300-002', DESCRIPCIÓN: '', UND: '', CANTIDAD: 9 },
  { CODIGO: 'BJ-109-003', DESCRIPCIÓN: 'Filtro de aire CORREGIDO', UND: 'UND', CANTIDAD: 6 },
]
const res = repMapearFilas(hoja, col)
ok(res.filas.length === 2, `2 filas válidas (recibidas ${res.filas.length})`)
// Normalización a mayúsculas
ok(res.filas[0].codigo === 'BJ-109-003', 'código normalizado a mayúsculas')
// Dedup: gana la ÚLTIMA aparición del código
ok(res.filas[0].descripcion === 'Filtro de aire CORREGIDO', 'duplicado dentro del archivo: gana la última')
ok(res.filas[0].cantidad_ref === 6, 'cantidad del duplicado final')
// cantidad con formato PE/US en texto
ok(res.filas[1].cantidad_ref === 1200.5, 'cantidad_ref "1,200.5" → 1200.5')
// Descartes honestos con número de fila de hoja
ok(res.descartes.some((d) => d.includes('Fila 4') && d.includes('código vacío')), `descarte fila 4 (código vacío): ${res.descartes.join(' | ')}`)
ok(res.descartes.some((d) => d.includes('Fila 5') && d.includes('descripción vacía')), 'descarte fila 5 (descripción vacía)')
ok(res.duplicadosArchivo.length === 1 && res.duplicadosArchivo[0] === 'BJ-109-003', 'duplicado reportado por código')
// Fila original preservada (para el reporte)
ok(res.filas[0].fila === 6, 'fila de hoja preservada (la última del duplicado, fila 6)')

// Fila de encabezado repetida (Excel con filtros) se ignora en silencio
const res2 = repMapearFilas([{ CODIGO: 'CODIGO', DESCRIPCIÓN: 'DESCRIPCIÓN' }, { CODIGO: 'X-1', DESCRIPCIÓN: 'ok', UND: '', CANTIDAD: '' }], col)
ok(res2.filas.length === 1, 'encabezado repetido no cuenta como fila')

console.log(`OK test_rep_excel — ${n} aserciones`)
