/**
 * RACKLY — Tests unitarios de guia-excel.ts (exportación Excel de la guía).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_guia_excel.js --bundle --platform=node --outfile=/tmp/test_excel.cjs --alias:@=/home/z/my-project/rackly/src --loader:.ts=ts && node /tmp/test_excel.cjs
 *
 * Escenarios:
 *   1. nombreArchivoGuia: nombre seguro (sin espacios/slashes/tildes).
 *   2. filasGuiaAExcel: paleta a SU columna, observaciones limpias, orden.
 *   3. El libro se arma y escribe en node (writeFile funciona igual):
 *      se verifica que el archivo .xlsx REAL se genera y pesa > 0.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { nombreArchivoGuia, filasGuiaAExcel, exportarGuiaExcel } = require('@/lib/rackly/guia-excel')

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
  createdAt: '2026-10-12T09:30:00Z',
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
  } finally {
    process.chdir(cwdAntes)
  }
  console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
  process.exit(fallidos > 0 ? 1 : 0)
})().catch((e) => {
  console.error('ERROR FATAL:', e)
  process.exit(1)
})
