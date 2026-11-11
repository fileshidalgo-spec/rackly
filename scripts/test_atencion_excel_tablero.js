#!/usr/bin/env node
/**
 * RACKLY — 2026-11-12 · EXCEL del TABLERO por línea + turno de la hoja
 * Salidas derivado (fix del ledger con turno vacío).
 *
 * Suite STUB (atencion-excel.ts importa atencion-reporte que toca
 * dataClient; el xlsx real queda --external y no se usa en las funciones
 * puras probadas aquí):
 *   A. tablaTablero: título/filtros + cabecera LINEA..Suma de CANTIDAD +
 *      subtotal por línea + TOTAL GENERAL con marcadores estilizables.
 *   B. nombreArchivoTablero.
 *   C. filasHojaSalidas: 'Turno salida' NUNCA vacío (columna o derivado
 *      de la hora Lima — 309 filas históricas venían con '').
 */
const stub = require('../scripts/stubs/supabase_client_stub.js')
const { tablaTablero, nombreArchivoTablero, filasHojaSalidas } = require('../src/lib/rackly/atencion-excel')

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

// ── A. tablaTablero ───────────────────────────────────────────────────
const filas = [
  { linea: 'Línea 2', producto: 'SPORADE TROPICAL', sku: '118', descripcion: 'ÁCIDO CÍTRICO', cantidad: 10, numTomas: 4 },
  { linea: 'Línea 2', producto: 'VOLT ORIGINAL', sku: 'TAU', descripcion: 'TAURINA', cantidad: 7, numTomas: 1 },
  { linea: 'Materiales auxiliares', producto: 'MATERIALES AUXILIARES', sku: 'AC-101', descripcion: 'ALCALINO', cantidad: 2, numTomas: 1 },
]
const aoa = tablaTablero('2026-11-10', '2026-11-10', ['T1', 'T2'], filas, '12/11/2026, 09:00:00')

check('A1 · título', aoa[0][0] === 'TABLERO DE ATENCIONES POR LÍNEA Y MATERIALES AUXILIARES')
check('A2 · filtros FECHA y TURNO', aoa[1][0] === 'FECHA: 2026-11-10 al 2026-11-10' && aoa[2][0] === 'TURNO: T1 · T2')
check('A3 · nota de salidas netas', String(aoa[3][0]).includes('Salidas NETAS') && String(aoa[3][0]).includes('Generado'))
check('A4 · cabecera en fila 5', JSON.stringify(aoa[5]) === JSON.stringify(['LINEA', 'PRODUCTO', 'sku', 'DESCRIPCION', 'Suma de CANTIDAD']))
check('A5 · filas de datos en orden', aoa[6][0] === 'Línea 2' && aoa[6][2] === '118' && aoa[6][4] === 10 && aoa[7][2] === 'TAU' && aoa[7][4] === 7)
check('A6 · subtotal al cambiar de línea', aoa[8][0] === 'Total Línea 2' && aoa[8][4] === 17)
check('A7 · segunda línea de datos + su subtotal', aoa[9][0] === 'Materiales auxiliares' && aoa[10][0] === 'Total Materiales auxiliares' && aoa[10][4] === 2)
check('A8 · TOTAL GENERAL cierra', aoa[11][0] === 'TOTAL GENERAL' && aoa[11][4] === 19)
check('A9 · sin filas → solo TOTAL GENERAL 0', (() => {
  const a = tablaTablero('2026-11-01', '2026-11-01', ['T1'], [], 'g')
  return a.length === 7 && a[6][0] === 'TOTAL GENERAL' && a[6][4] === 0
})())

// ── B. nombre ─────────────────────────────────────────────────────────
check('B1 · nombre del archivo con rango', /^Tablero_Atenciones_Linea_2026-11-10_2026-11-10_\d{8}\.xlsx$/.test(nombreArchivoTablero('2026-11-10', '2026-11-10')))

// ── C. filasHojaSalidas: turno derivado ───────────────────────────────
const rqs = [{ id: 'rq-1', fecha: '2026-11-10', numeroRq: '0000190001', ordenProduccion: '', productoCodigo: '', productoDescripcion: '', turno: 'T1', turnoRq: 'T1', linea: 'Línea 2', solicitante: 'U', estado: 'Atendido', notas: '', usuarioNombre: 'U', createdAt: '' }]
const items = [{ id: 'it-1', rqId: 'rq-1', orden: 0, codigo: '118', descripcion: 'ÁCIDO CÍTRICO', unidad: 'KG', cantidad: 10, cantidadAtendida: 10, usuarioAtencion: 'U', atendidoEn: '' }]
const venc = new Map()
const salidas = filasHojaSalidas(
  rqs,
  items,
  [
    // turno VACÍO (ledger histórico) → derivado de la hora Lima (10:00 → T1)
    { rqId: 'rq-1', itemId: 'it-1', codigo: '118', origen: 'manual', cantidad: 5, ubicacion: '', saldoResultante: null, lote: '', usuarioNombre: 'U', turno: '', creadoEn: '2026-11-10T15:00:00Z' },
    // turno VACÍO a las 20:00 Lima → T2 (reversa REAL: origen reversa, −2)
    { rqId: 'rq-1', itemId: 'it-1', codigo: '118', origen: 'reversa', cantidad: -2, ubicacion: '', saldoResultante: null, lote: '', usuarioNombre: 'U', turno: '', creadoEn: '2026-11-11T01:00:00Z' },
    // turno de la columna si vino
    { rqId: 'rq-1', itemId: 'it-1', codigo: '118', origen: 'manual', cantidad: 1, ubicacion: '', saldoResultante: null, lote: '', usuarioNombre: 'U', turno: 'T1', creadoEn: '2026-11-10T16:00:00Z' },
  ],
  venc
)
check('C1 · turno derivado 10:00 Lima → T1', salidas[0]['Turno salida'] === 'T1')
check('C2 · turno derivado 20:00 Lima → T2', salidas[1]['Turno salida'] === 'T2')
check('C3 · columna de la BD manda', salidas[2]['Turno salida'] === 'T1')
check('C4 · reversa marcada REVERSA', salidas[1].Tipo === 'REVERSA')
check('C5 · cantidad con signo (reversa −2)', salidas[1].Cantidad === -2)

console.log(`— excel tablero: ${ok} checks —`)
if (process.exitCode) process.exit(1)
