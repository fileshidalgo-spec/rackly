/**
 * RACKLY — Tests del REPORTE de atención a líneas (módulo Atención).
 *
 * Feature 2026-10-29: Excel descargable (RQs + Materiales + Salidas con
 * vencimiento + Resumen por artículo + Dashboard) y vista dashboard.
 *
 * Suite CON STUB de Supabase: las agregaciones y los armados de hoja son
 * PUROS; cargarReporteAtencion() se prueba con tablas enlatadas
 * (rq_atenciones / rq_atencion_items / rq_atencion_tomas / movimientos).
 * Requiere estar listado en CON_STUB de scripts/run_all_tests.sh.
 */
const stub = require('./stubs/supabase_client_stub.js')
const {
  construirMapaVencimiento,
  paresLoteDeTomas,
  kpisAtencion,
  resumenPorArticulo,
  serieRqsPorDia,
  serieRqsPorLinea,
  topArticulosAtendidos,
  cargarReporteAtencion,
} = require('../src/lib/rackly/atencion-reporte.ts')
const {
  nombreArchivoReporte,
  filasHojaRqs,
  filasHojaMateriales,
  filasHojaSalidas,
  filasHojaResumen,
  tablaDashboard,
} = require('../src/lib/rackly/atencion-excel.ts')

let ok = 0
let total = 0
function check(nombre, cond) {
  total++
  if (cond) {
    ok++
    console.log(`  ✓ ${nombre}`)
  } else {
    console.log(`  ✗ ${nombre}`)
  }
}

/** Fila cruda (snake_case) → ReporteItem (camelCase), igual que filaAItem. */
const mIt = (r) => ({
  id: r.id,
  rqId: r.rq_id,
  orden: r.orden,
  codigo: r.codigo,
  descripcion: r.descripcion,
  unidad: r.unidad,
  cantidad: r.cantidad,
  cantidadAtendida: r.cantidad_atendida,
  usuarioAtencion: r.usuario_atencion,
  atendidoEn: r.atendido_en,
})
const mRq = (r) => ({
  id: r.id,
  fecha: r.fecha,
  numeroRq: r.numero_rq,
  ordenProduccion: r.orden_produccion,
  productoCodigo: r.producto_codigo,
  productoDescripcion: r.producto_descripcion,
  turno: r.turno,
  turnoRq: r.turno_rq,
  linea: r.linea,
  solicitante: r.solicitante,
  estado: r.estado,
  notas: r.notas,
  usuarioNombre: r.usuario_nombre,
  createdAt: r.created_at,
})

const mToma = (r) => ({
  rqId: r.rq_id,
  itemId: r.item_id,
  codigo: r.codigo,
  origen: r.origen,
  cantidad: r.cantidad,
  ubicacion: r.ubicacion,
  saldoResultante: r.saldo_resultante,
  lote: r.lote,
  usuarioNombre: r.usuario_nombre,
  turno: r.turno,
  creadoEn: r.creado_en,
})

const RQ = {
  id: 'rq-1',
  fecha: '2026-10-29',
  numero_rq: '0000192737',
  orden_produccion: 'OP-77',
  producto_codigo: '3000261',
  producto_descripcion: 'BEBIDA X 500ML',
  turno: 'T1',
  turno_rq: 'T1',
  linea: 'L1',
  solicitante: 'ENRIQUEZ, JHONNIE',
  estado: 'Atendido',
  notas: '',
  usuario_nombre: 'Miguel Hidalgo',
  created_at: '2026-10-29T10:46:04Z',
}
const RQ2 = { ...RQ, id: 'rq-2', numero_rq: '0000192811', estado: 'Pendiente', linea: 'L2', fecha: '2026-10-28' }
const RQ3 = { ...RQ, id: 'rq-3', numero_rq: '0000192454', estado: 'En proceso', linea: '', fecha: '2026-10-29' }

const ITEMS = [
  { id: 'it-1', rq_id: 'rq-1', orden: 0, codigo: '118', descripcion: 'ACIDO CITRICO', unidad: 'KG', cantidad: 100, cantidad_atendida: 100, usuario_atencion: 'Andy Maiz', atendido_en: '2026-10-29T15:00:00Z' },
  { id: 'it-2', rq_id: 'rq-1', orden: 1, codigo: '122', descripcion: 'AZUCAR', unidad: 'KG', cantidad: 50, cantidad_atendida: 30, usuario_atencion: 'Andy Maiz', atendido_en: '' },
  { id: 'it-3', rq_id: 'rq-2', orden: 0, codigo: '118', descripcion: 'ACIDO CITRICO', unidad: 'KG', cantidad: 200, cantidad_atendida: 250, usuario_atencion: 'Cesar Blas', atendido_en: '2026-10-28T20:00:00Z' },
  { id: 'it-4', rq_id: 'rq-2', orden: 1, codigo: '54118', descripcion: 'ETIQUETA SPORADE', unidad: 'UN', cantidad: 1000, cantidad_atendida: 0, usuario_atencion: '', atendido_en: '' },
]
const TOMAS = [
  { rq_id: 'rq-1', item_id: 'it-1', codigo: '118', origen: 'racks', cantidad: 100, ubicacion: 'B8·T1·P3·Pos5', saldo_resultante: 25, lote: 'L-01', usuario_nombre: 'Andy Maiz', turno: 'Día', creado_en: '2026-10-29T15:00:00Z' },
  { rq_id: 'rq-2', item_id: 'it-3', codigo: '118', origen: 'transito', cantidad: 250, ubicacion: '', saldo_resultante: null, lote: '1810-26', usuario_nombre: 'Cesar Blas', turno: '', creado_en: '2026-10-28T20:00:00Z' },
  { rq_id: 'rq-1', item_id: 'it-2', codigo: '122', origen: 'manual', cantidad: 30, ubicacion: '', saldo_resultante: null, lote: '', usuario_nombre: 'Andy Maiz', turno: '', creado_en: '2026-10-29T16:00:00Z' },
  { rq_id: 'rq-1', item_id: 'it-1', codigo: '118', origen: 'reversa', cantidad: -20, ubicacion: 'B8·T1·P3·Pos5', saldo_resultante: 45, lote: 'L-01', usuario_nombre: 'Andy Maiz', turno: '', creado_en: '2026-10-29T17:00:00Z' },
]
const MOVS = [
  { codigo: '118', lote: 'L-01', f_vencimiento: '2027-03-01' },
  { codigo: '118', lote: 'L-01', f_vencimiento: '2027-02-01' }, // corrección: gana el mayor
  { codigo: '118', lote: '1810-26', f_vencimiento: '2027-10-01' },
  { codigo: '999', lote: 'L-99', f_vencimiento: '2027-01-01' }, // no involucrado
]

console.log('— construirMapaVencimiento / paresLoteDeTomas (puras) —')
{
  const mapa = construirMapaVencimiento(TOMAS, MOVS)
  check('118|L-01 → mayor vencimiento', mapa.get('118|L-01') === '2027-03-01')
  check('118|1810-26 → vencimiento puente', mapa.get('118|1810-26') === '2027-10-01')
  check('no involucrado ausente', !mapa.has('999|L-99'))
  const pares = paresLoteDeTomas(TOMAS)
  check('pares únicos (2) — sin lote vacío', pares.length === 2)
  check('par sin duplicar L-01', pares.filter((p) => p.lote === 'L-01').length === 1)
}

console.log('— kpisAtencion —')
{
  const rqs = [RQ, RQ2, RQ3].map(mRq)
  const items = ITEMS.map(mIt)
  const k = kpisAtencion(rqs, items)
  check('total 3', k.totalRqs === 3)
  check('pendientes 1 · enProceso 1 · atendidas 1', k.pendientes === 1 && k.enProceso === 1 && k.atendidas === 1)
  check('materiales 4 · completados 2', k.materiales === 4 && k.materialesAtendidos === 2)
  check('% 50.0', k.pctAtencion === 50)
  check('unidades pedidas 1350 · atendidas 380', k.unidadesPedidas === 1350 && k.unidadesAtendidas === 380)
}

console.log('— resumenPorArticulo —')
{
  const res = resumenPorArticulo(ITEMS.map(mIt), [RQ, RQ2, RQ3].map(mRq))
  check('3 códigos', res.length === 3)
  const acido = res.find((r) => r.codigo === '118')
  check('acido: 2 RQs', acido.numRqs === 2)
  check('acido: pedido 300 · atendido 350', acido.totalPedido === 300 && acido.totalAtendido === 350)
  check('acido: pendiente 0 (sobreatención no penaliza)', acido.pendiente === 0)
  check('acido: % 116.7', acido.pctAtendido === 116.7)
  check('acido: usuarios ordenados', acido.usuarios.join('|') === 'Andy Maiz|Cesar Blas')
  const azucar = res.find((r) => r.codigo === '122')
  check('azucar: pendiente 20 · parcial', azucar.pendiente === 20 && azucar.totalAtendido === 30)
  check('orden por atendido desc', res[0].codigo === '118')
}

console.log('— series / top —')
{
  const rqs = [RQ, RQ2, RQ3].map(mRq)
  const serie = serieRqsPorDia(rqs, 14)
  check('serie 14 días', serie.length === 14)
  const d29 = serie.find((d) => d.dia === '2026-10-29')
  check('29/10: 2 registradas · 1 atendida', d29.rqs === 2 && d29.atendidas === 1)
  const lineas = serieRqsPorLinea(rqs)
  check('líneas: L1 y L2 y Sin línea (1 RQ c/u)', lineas.length === 3 && lineas.every((l) => l.rqs === 1) && lineas[0].linea === 'L1')
  const top = topArticulosAtendidos(ITEMS.map(mIt))
  check('top: solo atendidos>0 (2)', top.length === 2)
  check('top: 118 primero con 350', top[0].codigo === '118' && top[0].atendido === 350)
}

console.log('— hojas del Excel (puras) —')
{
  const rqs = [RQ, RQ2, RQ3].map(mRq)
  const items = ITEMS.map(mIt)
  const tomas = TOMAS.map(mToma)
  const mapa = construirMapaVencimiento(tomas, MOVS)

  check('nombre de archivo con fecha hoy', /^Reporte_Atencion_Lineas_\d{4}-\d{2}-\d{2}\.xlsx$/.test(nombreArchivoReporte()))

  const hRqs = filasHojaRqs(rqs)
  check('RQs: 3 filas · 14 columnas', hRqs.length === 3 && Object.keys(hRqs[0]).length === 14)
  check('RQs: numeroRq presente', hRqs[0]['Nº RQ'] === '0000192737')

  const hMat = filasHojaMateriales(rqs, items)
  check('Materiales: 4 filas · 15 columnas', hMat.length === 4 && Object.keys(hMat[0]).length === 15)
  check('Materiales: pendiente parcial 20', hMat.find((f) => f['Código'] === '122').Pendiente === 20)
  check('Materiales: estado Parcial', hMat.find((f) => f['Código'] === '122').Estado === 'Parcial')

  const hSal = filasHojaSalidas(rqs, items, tomas, mapa)
  check('Salidas: 4 filas · 18 columnas', hSal.length === 4 && Object.keys(hSal[0]).length === 18)
  const reversa = hSal.find((f) => f.Origen === 'reversa')
  check('Salidas: reversa marcada REVERSA · -20', reversa.Tipo === 'REVERSA' && reversa.Cantidad === -20)
  const conLote = hSal.find((f) => f.Lote === 'L-01' && f.Cantidad > 0)
  check('Salidas: vencimiento resuelto 2027-03-01', conLote['F. vencimiento'] === '2027-03-01')
  check('Salidas: descripción viene del item (join item_id)', conLote['Descripción'] === 'ACIDO CITRICO')
  const sinLote = hSal.find((f) => f.Origen === 'manual')
  check('Salidas: sin lote → vencimiento vacío', sinLote['F. vencimiento'] === '')

  const hRes = filasHojaResumen(resumenPorArticulo(items, rqs))
  check('Resumen: 3 filas · 12 columnas', hRes.length === 3 && Object.keys(hRes[0]).length === 12)

  const tabla = tablaDashboard(kpisAtencion(rqs, items), serieRqsPorDia(rqs), serieRqsPorLinea(rqs), topArticulosAtendidos(items))
  check('Dashboard: título + KPIs + 3 bloques', tabla[0][0] === 'REPORTE DE ATENCIÓN A LÍNEAS — RESUMEN' && tabla.some((f) => f[0] === 'RQs POR DÍA') && tabla.some((f) => f[0] === 'RQs POR LÍNEA') && tabla.some((f) => f[0] === 'TOP ARTÍCULOS ATENDIDOS'))
}

console.log('— cargarReporteAtencion con stub —')
;(async () => {
  stub.__clear()
  stub.__setTable('rq_atenciones', [RQ, RQ2, RQ3])
  stub.__setTable('rq_atencion_items', ITEMS)
  stub.__setTable('rq_atencion_tomas', TOMAS)
  stub.__setTable('movimientos', MOVS)
  const datos = await cargarReporteAtencion()
  check('carga: 3 RQs · 4 items · 4 tomas', datos.rqs.length === 3 && datos.items.length === 4 && datos.tomas.length === 4)
  check('carga: item mapeado con id', datos.items[0].id === 'it-1' && datos.items[0].rqId === 'rq-1')
  check('carga: vencimientos resueltos', datos.vencimientos.get('118|L-01') === '2027-03-01')
  check('carga: orden tomas cronológico', new Date(datos.tomas[0].creadoEn) <= new Date(datos.tomas[datos.tomas.length - 1].creadoEn))

  console.log('— resultado —')
  console.log(`${ok}/${total} checks OK`)
  if (ok !== total) process.exit(1)
})().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
