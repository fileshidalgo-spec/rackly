/**
 * RACKLY — Tests del Excel POR RANGO DE FECHAS + TURNOS (Recepción).
 *
 * Ejecutar (o bash scripts/run_all_tests.sh):
 *   npx esbuild scripts/test_recepcion_excel_rango.js --bundle --platform=node \
 *     --alias:@=./src --outfile=scripts/.testbuild/test_recepcion_excel_rango.cjs \
 *     --loader:.ts=ts --loader:.tsx=tsx --log-level=error \
 *     && node scripts/.testbuild/test_recepcion_excel_rango.cjs
 *
 * Cubre el pedido del usuario 2026-11-11 ("un Excel por el rango de fechas
 * que seleccione y por los turnos dentro de esa selección"):
 *   - filtrarPorTurnos: T1/T2 por created_at (regla Lima), filas sin fecha
 *     solo con ambos turnos, ambos marcados = sin filtro.
 *   - agruparTurnos: filas/cantidad/documentos distintos por turno.
 *   - filasRangoAExcel: contexto de documento (fecha/tipo/Nº/empresa/placa)
 *     + paleta a SU columna + turno por fila.
 *   - guiasRangoAExcel: estado Mixto, turnos distintos por documento.
 *   - nombreArchivoRango: prefijo por pestaña y fechas ISO.
 *   - El libro REAL se genera en node (xlsx-js-style), se relee y se
 *     verifican sus 2 hojas (Resumen con filtros/resumen por turno/
 *     documentos + Artículos con contexto).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  filtrarPorTurnos,
  agruparTurnos,
  filasRangoAExcel,
  guiasRangoAExcel,
  nombreArchivoRango,
  construirLibroRango,
} = require('@/lib/rackly/recepcion-excel-rango')
const { agruparGuias } = require('@/lib/rackly/recepcion-filas')

let pasados = 0
let fallidos = 0

function check(nombre, cond, detalle = '') {
  if (cond) {
    pasados++
    console.log(`  ✓ ${nombre}`)
  } else {
    fallidos++
    console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`)
  }
}

/** Fila registrada de prueba (created_at controla el TURNO). Usa !== undefined
 *  para que '' y null (casos límite reales) NO caigan al default. */
function fila(overrides = {}) {
  return {
    id: overrides.id !== undefined ? overrides.id : `f${Math.random()}`,
    createdAt: overrides.createdAt !== undefined ? overrides.createdAt : '2026-11-05T12:00:00.000Z',
    guiaId: overrides.guiaId !== undefined ? overrides.guiaId : 'G-1',
    fecha: overrides.fecha || '2026-11-05',
    tipoDocumento: overrides.tipoDocumento || 'Guia',
    numeroDocumento: overrides.numeroDocumento || 'T001-00000123',
    empresaOrigen: overrides.empresaOrigen || 'AJEPER S. A.',
    proveedor: overrides.proveedor || 'PROVEEDOR FILM',
    placa: overrides.placa || 'ABC-123',
    fotoUrl: '',
    estado: overrides.estado || 'Pendiente',
    usuarioId: 'u1',
    usuarioNombre: 'Operario',
    usuarioCorreo: 'op@ajeper.pe',
    codigo: overrides.codigo || '55630',
    descripcion: overrides.descripcion || 'PREFORMA PET 19.7',
    cantidad: overrides.cantidad ?? 100,
    unidadMedida: 'UN',
    lote: 'L1',
    fechaProduccion: '2026-11-01',
    fechaVencimiento: '2027-11-01',
    observaciones: overrides.observaciones || '',
    tipoRecepcion: 'guia',
  }
}

// created_at 12:00 UTC = 07:00 Lima (T2) · 14:30 UTC = 09:30 Lima (T1)
// OJO: la regla es Lima — usar horas locales de Lima simuladas via UTC-5.
const T1_MEDIO_DIA = '2026-11-05T14:30:00.000Z' // 09:30 Lima → T1
const T2_MADRUGADA = '2026-11-05T12:00:00.000Z' // 07:00 Lima → T2
const T1_TARDE = '2026-11-05T22:00:00.000Z'     // 17:00 Lima → T1
const T2_NOCHE = '2026-11-06T01:00:00.000Z'     // 20:00 Lima → T2

function filaConTurno(createdAt, extra = {}) {
  return fila({ createdAt, ...extra })
}

// ── 1. filtrarPorTurnos ──
console.log('filtrarPorTurnos:')
{
  const filas = [
    filaConTurno(T1_MEDIO_DIA, { id: 'a' }),
    filaConTurno(T2_MADRUGADA, { id: 'b' }),
    filaConTurno(T1_TARDE, { id: 'c' }),
    filaConTurno(T2_NOCHE, { id: 'd' }),
    fila({ id: 'sin-fecha', createdAt: '' }),
  ]
  check('solo T1 → 2 filas (sin fecha excluida)',
    filtrarPorTurnos(filas, ['T1']).map((f) => f.id).join() === 'a,c')
  check('solo T2 → 2 filas (sin fecha excluida)',
    filtrarPorTurnos(filas, ['T2']).map((f) => f.id).join() === 'b,d')
  check('T1+T2 → todas incluidas (5)',
    filtrarPorTurnos(filas, ['T1', 'T2']).length === 5)
  check('fila sin created_at se conserva SOLO con ambos turnos',
    filtrarPorTurnos([fila({ id: 'x', createdAt: '' })], ['T1']).length === 0 &&
    filtrarPorTurnos([fila({ id: 'x', createdAt: '' })], ['T1', 'T2']).length === 1)
}

// ── 2. agruparTurnos ──
console.log('agruparTurnos:')
{
  const filas = [
    filaConTurno(T1_MEDIO_DIA, { guiaId: 'G-1', cantidad: 100 }),
    filaConTurno(T1_TARDE, { guiaId: 'G-1', cantidad: 50 }),
    filaConTurno(T1_TARDE, { guiaId: 'G-2', cantidad: 25.5 }),
    filaConTurno(T2_NOCHE, { guiaId: 'G-3', cantidad: 200 }),
    filaConTurno(T2_MADRUGADA, { guiaId: 'G-3', cantidad: 0.5 }),
  ]
  const tot = agruparTurnos(filas)
  check('dos turnos presentes (T1, T2)', tot.length === 2 && tot[0].turno === 'T1' && tot[1].turno === 'T2')
  check('T1: 3 filas · 175.5 · 2 documentos',
    tot[0].filas === 3 && Math.abs(tot[0].cantidad - 175.5) < 1e-9 && tot[0].documentos === 2)
  check('T2: 2 filas · 200.5 · 1 documento',
    tot[1].filas === 2 && Math.abs(tot[1].cantidad - 200.5) < 1e-9 && tot[1].documentos === 1)
  check('residuo sin guia_id agrupa por tipo+número',
    agruparTurnos([
      filaConTurno(T1_MEDIO_DIA, { guiaId: null, numeroDocumento: 'T001-1', tipoDocumento: 'Guia' }),
      filaConTurno(T1_TARDE, { guiaId: null, numeroDocumento: 'T001-1', tipoDocumento: 'Guia' }),
      filaConTurno(T1_TARDE, { guiaId: null, numeroDocumento: 'T001-2', tipoDocumento: 'Guia' }),
    ])[0].documentos === 2)
}

// ── 3. filasRangoAExcel (contexto de documento + paleta + turno) ──
console.log('filasRangoAExcel:')
{
  const filas = [
    filaConTurno(T1_MEDIO_DIA, {
      // La marca "Paleta i/N" real va AL FINAL (así la escribe expandirEnFilas)
      observaciones: 'cuando llegue el montacargas · Paleta 1/2',
      cantidad: 123.456,
    }),
    filaConTurno(T1_TARDE, { observaciones: 'Paleta 2/2', cantidad: 1 }),
  ]
  const rows = filasRangoAExcel(filas)
  check('una fila por fila registrada', rows.length === 2)
  check('columnas de contexto presentes',
    rows[0]['Fecha'] === '2026-11-05' && rows[0]['Tipo'] === 'Guia' &&
    rows[0]['Nº documento'] === 'T001-00000123' && rows[0]['Empresa origen'] === 'AJEPER S. A.' &&
    rows[0]['Placa'] === 'ABC-123')
  check('paleta a SU columna y observaciones limpias',
    rows[0]['Paleta'] === 'Paleta 1/2' && rows[0]['Observaciones'] === 'cuando llegue el montacargas')
  check('cantidad con 3 decimales', rows[0]['Cantidad'] === 123.456)
  check('turno por fila (regla Lima)', rows[0]['Turno'] === 'T1' && rows[1]['Turno'] === 'T1')
  check('numeración correlativa', rows[0]['Nº'] === 1 && rows[1]['Nº'] === 2)
}

// ── 4. guiasRangoAExcel (estado Mixto + turnos distintos) ──
console.log('guiasRangoAExcel:')
{
  const guias = agruparGuias([
    filaConTurno(T1_MEDIO_DIA, { guiaId: 'G-9', estado: 'Pendiente', cantidad: 10 }),
    filaConTurno(T2_NOCHE, { guiaId: 'G-9', estado: 'Recibido', cantidad: 20 }),
  ])
  const rows = guiasRangoAExcel(guias)
  check('una fila por documento', rows.length === 1)
  check('estados distintos → Mixto', rows[0]['Estado'] === 'Mixto')
  check('turnos distintos del documento → T1·T2', rows[0]['Turnos'] === 'T1·T2')
  check('filas y cantidad del documento', rows[0]['Filas'] === 2 && rows[0]['Cantidad total'] === 30)
  check('estado homogéneo se respeta',
    guiasRangoAExcel(agruparGuias([filaConTurno(T1_MEDIO_DIA, { guiaId: 'G-8', estado: 'Recibido' })]))[0]['Estado'] === 'Recibido')
}

// ── 5. nombreArchivoRango ──
console.log('nombreArchivoRango:')
{
  check('formato Recepcion_Rango_DESDE_al_HASTA.xlsx',
    nombreArchivoRango('2026-11-01', '2026-11-11', 'Recepcion') === 'Recepcion_Rango_2026-11-01_al_2026-11-11.xlsx')
  check('pestaña devoluciones → prefijo Devoluciones',
    nombreArchivoRango('2026-11-01', '2026-11-11', 'Devoluciones').startsWith('Devoluciones_Rango_'))
  check('prefijo inválido cae a Recepcion',
    nombreArchivoRango('2026-11-01', '2026-11-11', '!!!') === 'Recepcion_Rango_2026-11-01_al_2026-11-11.xlsx')
}

// ── 6. El libro REAL se genera y se relee (2 hojas + contenido) ──
console.log('libro real (xlsx-js-style):')
{
  const XLSX = require('xlsx-js-style')
  const filas = [
    filaConTurno(T1_MEDIO_DIA, { guiaId: 'G-1', codigo: '55630', cantidad: 100 }),
    filaConTurno(T1_TARDE, { guiaId: 'G-2', codigo: '54063', cantidad: 441000 }),
    filaConTurno(T2_NOCHE, { guiaId: 'G-3', codigo: '57347', cantidad: 1896 }),
  ]
  const p = {
    desde: '2026-11-01',
    hasta: '2026-11-11',
    turnos: ['T1', 'T2'],
    etiquetaSeccion: 'Guías de recepción',
    prefijoArchivo: 'Recepcion',
    filas,
  }
  const { wb, guias } = construirLibroRango(p, XLSX)
  check('2 hojas: Resumen + Artículos', wb.SheetNames.join() === 'Resumen,Artículos')
  check('3 documentos agrupados', guias.length === 3)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rackly-rango-'))
  const archivo = path.join(dir, nombreArchivoRango(p.desde, p.hasta, p.prefijoArchivo))
  XLSX.writeFile(wb, archivo)
  const releido = XLSX.readFile(archivo)

  const res = XLSX.utils.sheet_to_json(releido.Sheets['Resumen'], { header: 1 })
  check('Resumen: título correcto',
    res[0][0] === 'RECEPCIÓN POR RANGO — GUÍAS DE RECEPCIÓN')
  const filaDesde = res.find((r) => r[0] === 'Desde')
  check('Resumen: filtros Desde/Hasta presentes',
    !!filaDesde && filaDesde[1] === '2026-11-01' &&
    res.find((r) => r[0] === 'Hasta')[1] === '2026-11-11')
  const rTurnoCab = res.findIndex((r) => r[0] === 'Turno' && r[1] === 'Documentos')
  check('Resumen: tabla por turno con T1 y T2',
    rTurnoCab > 0 && res[rTurnoCab + 1][0] === 'T1' && res[rTurnoCab + 2][0] === 'T2')
  check('Resumen: T1 suma 2 documentos y 441100',
    Math.abs(res[rTurnoCab + 1][3] - 441100) < 1e-9)
  const rDocCab = res.findIndex((r) => r[0] === 'Nº' && r[1] === 'Fecha')
  check('Resumen: tabla por documento con 3 filas',
    rDocCab > 0 && res.slice(rDocCab + 1).filter((r) => r[0] && r[1]).length >= 3)

  const art = XLSX.utils.sheet_to_json(releido.Sheets['Artículos'], { header: 1 })
  check('Artículos: cabecera con contexto de documento',
    art[0].includes('Nº documento') && art[0].includes('Empresa origen') && art[0].includes('Placa') && art[0].includes('Turno'))
  check('Artículos: 3 filas exportadas', art.length === 4)
  check('Artículos: fila con lote y turno',
    art[1][art[0].indexOf('Lote')] === 'L1' && art[1][art[0].indexOf('Turno')] === 'T1')

  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('════════ RESULTADO:', pasados, 'pasados,', fallidos, 'fallidos ══')
process.exit(fallidos === 0 ? 0 : 1)
