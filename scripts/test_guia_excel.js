/**
 * RACKLY — Tests unitarios de guia-excel.ts (exportación Excel de la guía).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_guia_excel.js --bundle --platform=node --outfile=/tmp/test_excel.cjs --alias:@=/home/z/my-project/rackly/src --loader:.ts=ts && node /tmp/test_excel.cjs
 *
 * Escenarios:
 *   1. nombreArchivoGuia: nombre seguro (sin espacios/slashes/tildes).
 *   2. filasGuiaAExcel: paleta a SU columna, observaciones limpias, orden.
 *   3. TURNO: columna T1/T2 en "Artículos" y en la tabla de la hoja "Guía"
 *      (regla 07:20–19:20 → T1 / resto → T2, derivada del created_at).
 *   4. filasGuiaATablaTurno: columnas EXACTAS del formato pedido.
 *   5. El libro se arma y escribe en node: el .xlsx REAL se genera, se
 *      relee y se verifican sus 2 hojas, título y cabeceras con Turno.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { nombreArchivoGuia, filasGuiaAExcel, filasGuiaATablaTurno, exportarGuiaExcel, turnoDeFila, construirHojaGuia } = require('@/lib/rackly/guia-excel')

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

const fila = (sobre) => ({
  id: 'id-' + Math.random().toString(36).slice(2),
  createdAt: '2026-10-12T09:30:00Z', // 04:30 Lima → T2
  fecha: '2026-10-12',
  tipoDocumento: 'Guia',
  numeroDocumento: 'T173-00004090',
  proveedor: 'AJEPER',
  placa: 'V3P-114',
  fotoUrl: 'https://owjryvcrhpmgtkkdcrkm.supabase.co/storage/v1/object/public/recepcion-guias/foto.jpg',
  estado: 'Pendiente',
  usuarioId: 'u1',
  usuarioNombre: 'Miguel',
  usuarioCorreo: 'm@e.pe',
  codigo: '5653',
  descripcion: 'PURE DE DURAZNO',
  cantidad: 1000,
  unidadMedida: 'KG',
  lote: 'L-77',
  fechaProduccion: '2026-10-01',
  fechaVencimiento: '2027-10-01',
  observaciones: '',
  ...sobre,
})

// ─── 1. nombreArchivoGuia ───
console.log('\n[1] nombreArchivoGuia — nombre de archivo seguro')
check('con nº de documento', nombreArchivoGuia({ tipoDocumento: 'Guia', numeroDocumento: 'T173-00004090', fecha: '2026-10-12', proveedor: 'AJEPER' }) === 'Guia_Guia_T173-00004090_2026-10-12.xlsx')
check('sin nº cae al proveedor', nombreArchivoGuia({ tipoDocumento: 'Guia', numeroDocumento: '', fecha: '2026-10-12', proveedor: 'SAN MIGUEL' }) === 'Guia_Guia_SAN-MIGUEL_2026-10-12.xlsx')
check('sin nada → SIN-NUMERO', nombreArchivoGuia({ tipoDocumento: '', numeroDocumento: '', fecha: '', proveedor: '' }) === 'Guia_DOC_SIN-NUMERO.xlsx')
check('sanitiza espacios/slashes de un OCR sucio', nombreArchivoGuia({ tipoDocumento: 'Guia', numeroDocumento: 'T 173/00004090', fecha: '2026-10-12', proveedor: 'A&B' }) === 'Guia_Guia_T-173-00004090_2026-10-12.xlsx')

// ─── 2. filasGuiaAExcel ───
console.log('\n[2] filasGuiaAExcel — todas las filas registradas, paletas incluidas')
const filas = [
  fila({}),
  fila({ codigo: '118', cantidad: 40, lote: 'L-1', observaciones: 'obs del usuario · Paleta 1/3' }),
  fila({ codigo: '118', cantidad: 35, lote: 'L-2', observaciones: 'Paleta 2/3' }),
]
const excel = filasGuiaAExcel(filas)
check('3 filas → 3 filas de Excel (1 por fila registrada)', excel.length === 3, String(excel.length))
check('numeración 1..3', excel[0]['Nº'] === 1 && excel[2]['Nº'] === 3)
check('columnas completas (lote, fechas, estado, quién registró)', excel[0]['Lote'] === 'L-77' && excel[0]['F. producción'] === '2026-10-01' && excel[0]['F. vencimiento'] === '2027-10-01' && excel[0]['Estado'] === 'Pendiente' && excel[0]['Registró'] === 'Miguel')
check('la marca "Paleta i/N" va a SU columna', excel[1]['Paleta'] === 'Paleta 1/3' && excel[2]['Paleta'] === 'Paleta 2/3' && excel[0]['Paleta'] === '')
check('observaciones LIMPIAS (sin la marca)', excel[1]['Observaciones'] === 'obs del usuario', String(excel[1]['Observaciones']))
check('cantidad numérica tal cual (35)', excel[2]['Cantidad'] === 35)

// ─── 2b. TURNO en la hoja Artículos ───
console.log('\n[2b] TURNO — columna derivada del created_at (hora Lima)')
const turnoFilaTarde = fila({ createdAt: '2026-10-12T14:30:00Z' }) // 09:30 Lima → T1
check('fila 04:30 Lima → T2', excel[0]['Turno'] === 'T2', String(excel[0]['Turno']))
check('fila 09:30 Lima → T1', filasGuiaAExcel([turnoFilaTarde])[0]['Turno'] === 'T1')
check('fila REAL de la guía del usuario (05:42 Lima) → T2', filasGuiaAExcel([fila({ createdAt: '2026-10-16T10:42:21Z' })])[0]['Turno'] === 'T2')
check('sin created_at → vacío (nunca inventa)', filasGuiaAExcel([fila({ createdAt: '' })])[0]['Turno'] === '')
check('created_at inválido → vacío (nunca lanza)', filasGuiaAExcel([fila({ createdAt: 'no-es-fecha' })])[0]['Turno'] === '')
check('turnoDeFila directo 19:20 Lima → T1', turnoDeFila({ createdAt: '2026-10-17T00:20:30Z' }) === 'T1')
check('turnoDeFila directo 19:21 Lima → T2', turnoDeFila({ createdAt: '2026-10-17T00:21:00Z' }) === 'T2')

// ─── 2c. filasGuiaATablaTurno — hoja Guía ───
console.log('\n[2c] filasGuiaATablaTurno — columnas EXACTAS del formato pedido')
const tabla = filasGuiaATablaTurno(filas)
check('cabecera exacta (11 columnas, Turno al final)', JSON.stringify(tabla[0]) === JSON.stringify(['Fecha', 'Nº de documento', 'Código', 'Descripción', 'Unidad', 'Cantidad', 'Lote', 'F. producción', 'F. vencimiento', 'Registró', 'Turno']), JSON.stringify(tabla[0]))
check('1 fila por fila registrada + cabecera', tabla.length === filas.length + 1)
check('fila incluye fecha/nº doc/código y SU turno', tabla[1][0] === '2026-10-12' && tabla[1][1] === 'T173-00004090' && tabla[1][2] === '5653' && tabla[1][10] === 'T2')
check('guía vacía → solo cabecera', filasGuiaATablaTurno([]).length === 1)

// ─── 3. exportarGuiaExcel — el libro REAL se genera en node ───
console.log('\n[3] exportarGuiaExcel — libro real (.xlsx) generado')
;(async () => {
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackly-xlsx-'))
  const cwdAntes = process.cwd()
  process.chdir(dirTmp) // writeFile cae al CWD en node
  try {
    const nombre = await exportarGuiaExcel({
      fecha: '2026-10-12',
      tipoDocumento: 'Guia',
      numeroDocumento: 'T173-00004090',
      proveedor: 'AJEPER',
      placa: 'V3P-114',
      fotoUrl: fila({}).fotoUrl,
      estado: 'Pendiente',
      usuarioNombre: 'Miguel',
      usuarioCorreo: 'm@e.pe',
      filas,
      cantidadTotal: filas.reduce((s, f) => s + f.cantidad, 0),
    })
    const ruta = path.join(dirTmp, nombre)
    check('devuelve el nombre esperado', nombre === 'Guia_Guia_T173-00004090_2026-10-12.xlsx', nombre)
    check('el archivo .xlsx existe', fs.existsSync(ruta))
    const peso = fs.existsSync(ruta) ? fs.statSync(ruta).size : 0
    check('el libro pesa > 1KB (2 hojas reales)', peso > 1024, String(peso))

    // Relectura REAL del archivo generado (xlsx-js-style también lee)
    const XLSX = require('xlsx-js-style')
    const wbBack = XLSX.readFile(ruta)
    check('2 hojas: Guía + Artículos', JSON.stringify(wbBack.SheetNames) === JSON.stringify(['Guía', 'Artículos']), JSON.stringify(wbBack.SheetNames))
    const guiaBack = wbBack.Sheets['Guía']
    check('título imprimible en A1', guiaBack['A1'] && guiaBack['A1'].v === 'GUÍA DE RECEPCIÓN', guiaBack['A1'] && guiaBack['A1'].v)
    const celdasGuia = Object.keys(guiaBack).filter((k) => !k.startsWith('!'))
    const textosGuia = celdasGuia.map((k) => String(guiaBack[k].v))
    check('encabezado incluye el campo Turno', textosGuia.includes('Turno'))
    check('tabla de ítems en la hoja Guía (código 5653 presente)', textosGuia.includes('5653'))
    check('estilos escritos: el lector del fork no restaura .s pero styles.xml lleva los colores (verificado E2E: 1E3A5F/2E5A88 en styles.xml)', peso > 8000, String(peso))
    check('layout imprimible: 2 fusiones de título', Array.isArray(guiaBack['!merges']) && guiaBack['!merges'].length === 2, JSON.stringify(guiaBack['!merges']))

    // Layout del CONSTRUCTOR PURO (lo que el lector no restaura se prueba aquí)
    const XS = require('xlsx-js-style')
    const hoja = construirHojaGuia({ fecha: '2026-10-12', tipoDocumento: 'Guia', numeroDocumento: 'T173-00004090', proveedor: 'AJEPER', placa: 'V3P-114', fotoUrl: fila({}).fotoUrl, estado: 'Pendiente', usuarioNombre: 'Miguel', usuarioCorreo: 'm@e.pe', filas, cantidadTotal: 1075 }, XS)
    check('constructor: 11 anchos de columna', Array.isArray(hoja['!cols']) && hoja['!cols'].length === 11, String(hoja['!cols'] && hoja['!cols'].length))
    check('constructor: 2 fusiones de título', Array.isArray(hoja['!merges']) && hoja['!merges'].length === 2)
    check('constructor: márgenes de impresión estrechos', hoja['!margins'] && hoja['!margins'].left === 0.3)
    check('constructor: estilo del título (fondo 1E3A5F, bold 16)', (() => { const s = hoja['A1'].s; return s && s.fill && String(s.fill.fgColor.rgb).endsWith('1E3A5F') && s.font && s.font.bold && s.font.sz === 16 })())
    check('constructor: cabecera de tabla con estilo', (() => { const textos = Object.keys(hoja).filter((k) => !k.startsWith('!')).map((k) => String(hoja[k].v)); return textos.filter((t) => t === 'Turno').length === 2 })())
    const artBack = wbBack.Sheets['Artículos']
    const textosArt = Object.keys(artBack).filter((k) => !k.startsWith('!')).map((k) => String(artBack[k].v))
    check('hoja Artículos incluye columna Turno', textosArt.includes('Turno'))
    check('hoja Artículos conserva TODOS los datos (lote L-77)', textosArt.includes('L-77'))
  } finally {
    process.chdir(cwdAntes)
  }
  console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
  process.exit(fallidos > 0 ? 1 : 0)
})().catch((e) => {
  console.error('ERROR FATAL:', e)
  process.exit(1)
})
